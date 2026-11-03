// Hearthside · Kesiel — the backend tool (Anna Executa) for the Hearthside journal.
//
// One static binary (Go standard library only, CGO disabled): it runs on any Linux,
// macOS or Windows machine without an interpreter, shared libraries or a temp folder,
// which is what Anna's Cloud Agent needs.
//
// Protocol: Executa JSON-RPC 2.0 over stdin/stdout, one JSON object per line.
//   - stdout carries protocol messages only; logs go to stderr
//   - every response echoes the request id and ends with "\n"
//   - `describe` returns the manifest directly in `result` (no wrapper), immediately
//   - the process keeps reading stdin until it closes
//
// Kesiel's thinking happens on Anna's LLM via reverse sampling: the tool sends the host a
// `sampling/createMessage` request and waits for the reply, so no API key lives here.
//
// Methods (via `invoke`): reflect, suggest_prompt, ping.
package main

import (
	"bufio"
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed manifest.json
var manifestJSON []byte

var (
	manifest map[string]any
	version  = "0.0.0"
)

// Keep in step with REFLECT_SYSTEM in bundle/app.js (the frontend's fallback path).
const reflectSystem = "You are Kesiel, the gentle companion who lives in the margins of Hearthside, a private journal. " +
	"You have just read one journal entry. Write a brief reflection back to the writer: warm, specific to what " +
	"they wrote, never preachy, never diagnosing, no therapy-speak, no exclamation marks. Notice one concrete " +
	"detail and gently name a feeling or pattern you see. Then offer ONE open question they could write about next.\n" +
	"Rules: 2-4 sentences for the reflection (under 70 words). The question under 20 words. Write in the same " +
	"language as the entry. If the entry mentions self-harm or being in danger, kindly encourage reaching out to " +
	"someone they trust or local emergency services.\n" +
	`Reply ONLY with JSON: {"reflection": "...", "prompt": "..."}`

const promptSystem = "You are Kesiel, the gentle companion inside Hearthside, a private journal. Suggest ONE journaling prompt " +
	"for today: open-ended, concrete, kind, under 20 words, no exclamation marks. If recent entries are given, " +
	"let their themes or moods shape it gently without quoting them. Reply ONLY with JSON: {\"prompt\": \"...\"}"

const (
	maxText         = 6000
	samplingTimeout = 55 * time.Second
)

// ---------- wire types ----------

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// ---------- output (serialised; one line per message) ----------

var outMu sync.Mutex

func writeMsg(v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf) // Encode appends exactly one "\n"
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		logf("encode failed: %v", err)
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	os.Stdout.Write(buf.Bytes())
}

func reply(id json.RawMessage, result any) {
	if len(id) == 0 {
		return // notifications get no reply
	}
	writeMsg(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func replyError(id json.RawMessage, code int, msg string) {
	if len(id) == 0 {
		return
	}
	writeMsg(map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError{Code: code, Message: msg}})
}

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[kesiel] "+format+"\n", a...)
}

// ---------- reverse sampling ----------

var (
	pendingMu sync.Mutex
	pending   = map[string]chan envelope{}
	reqSeq    atomic.Int64
)

func idKey(raw json.RawMessage) string { return string(bytes.TrimSpace(raw)) }

// sample asks the Anna host to run its LLM and returns the reply text.
func sample(system, user string, maxTokens int, temperature float64) (string, error) {
	id := fmt.Sprintf("\"kesiel-s-%d\"", reqSeq.Add(1))
	ch := make(chan envelope, 1)
	pendingMu.Lock()
	pending[id] = ch
	pendingMu.Unlock()
	defer func() { pendingMu.Lock(); delete(pending, id); pendingMu.Unlock() }()

	writeMsg(map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(id),
		"method":  "sampling/createMessage",
		"params": map[string]any{
			"messages":     []any{map[string]any{"role": "user", "content": map[string]any{"type": "text", "text": user}}},
			"systemPrompt": system,
			"maxTokens":    maxTokens,
			"temperature":  temperature,
		},
	})

	select {
	case env := <-ch:
		if env.Error != nil {
			return "", fmt.Errorf("%d %s", env.Error.Code, env.Error.Message)
		}
		return contentText(env.Result), nil
	case <-time.After(samplingTimeout):
		return "", errors.New("sampling timed out")
	case <-stdinClosed:
		return "", errors.New("stdin closed before the sampling reply arrived")
	}
}

// contentText pulls the text out of a sampling result ({content:{type,text}} or a list of parts).
func contentText(raw json.RawMessage) string {
	var res struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(raw, &res) != nil {
		return ""
	}
	var one struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(res.Content, &one) == nil && one.Text != "" {
		return one.Text
	}
	var many []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(res.Content, &many) == nil {
		var b strings.Builder
		for _, p := range many {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	var s string
	if json.Unmarshal(res.Content, &s) == nil {
		return s
	}
	return ""
}

// ---------- helpers ----------

var jsonBlock = regexp.MustCompile(`(?s)\{.*\}`)

// parseReply accepts {"reflection": ..., "prompt": ...} (possibly wrapped in prose or code
// fences); anything else becomes the reflection text.
func parseReply(text string) map[string]string {
	text = strings.TrimSpace(text)
	out := map[string]string{}
	if m := jsonBlock.FindString(text); m != "" {
		var obj map[string]any
		if json.Unmarshal([]byte(m), &obj) == nil {
			for k, v := range obj {
				if s, ok := v.(string); ok {
					out[k] = s
				}
			}
			return out
		}
	}
	if text != "" {
		out["reflection"] = strings.Trim(text, "\"'` \n")
	}
	return out
}

func clip(v any, n int) string {
	s, _ := v.(string)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

func ok(data any) map[string]any     { return map[string]any{"success": true, "data": data} }
func fail(msg string) map[string]any { return map[string]any{"success": false, "error": msg} }

// ---------- methods ----------

func reflect(args map[string]any) map[string]any {
	text := clip(args["text"], maxText)
	if len(strings.Fields(text)) < 5 {
		return fail("text is too short to reflect on")
	}
	var b strings.Builder
	if name := clip(args["name"], 40); name != "" {
		b.WriteString("Writer's name: " + name + "\n")
	}
	title := clip(args["title"], 120)
	if title == "" {
		title = "Untitled"
	}
	mood := clip(args["mood"], 20)
	if mood == "" {
		mood = "not set"
	}
	b.WriteString("Entry title: " + title + "\n")
	b.WriteString("Mood they picked: " + mood + "\n\n")
	b.WriteString("Entry:\n" + text)
	if recent := clip(args["recent"], 1200); recent != "" {
		b.WriteString("\n\n(For gentle continuity only — their last few entries:)\n" + recent)
	}
	raw, err := sample(reflectSystem, b.String(), 400, 0.7)
	if err != nil {
		return fail("reflect failed: " + err.Error())
	}
	obj := parseReply(raw)
	reflection := clip(obj["reflection"], 900)
	if reflection == "" {
		return fail("the model returned an empty reflection")
	}
	return ok(map[string]any{"reflection": reflection, "prompt": clip(obj["prompt"], 200)})
}

func suggestPrompt(args map[string]any) map[string]any {
	recent := clip(args["recent"], 1500)
	if recent == "" {
		recent = "(no recent entries)"
	}
	raw, err := sample(promptSystem, recent, 120, 0.9)
	if err != nil {
		return fail("suggest_prompt failed: " + err.Error())
	}
	obj := parseReply(raw)
	p := obj["prompt"]
	if p == "" {
		p = obj["reflection"]
	}
	if p = clip(p, 200); p == "" {
		return fail("the model returned an empty prompt")
	}
	return ok(map[string]any{"prompt": p})
}

func invoke(tool string, args map[string]any) (res map[string]any) {
	defer func() { // never let one bad call take the process down
		if r := recover(); r != nil {
			logf("invoke %s panicked: %v", tool, r)
			res = fail(fmt.Sprintf("%s failed: internal error", tool))
		}
	}()
	if args == nil {
		args = map[string]any{}
	}
	switch tool {
	case "ping":
		return ok(map[string]any{"pong": true, "version": version})
	case "reflect":
		return reflect(args)
	case "suggest_prompt":
		return suggestPrompt(args)
	}
	return fail("unknown method: " + tool)
}

// ---------- dispatch ----------

type invokeParams struct {
	Tool      string         `json:"tool"`
	Method    string         `json:"method"`
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
	Args      map[string]any `json:"args"`
}

var (
	stdinClosed = make(chan struct{})
	inflight    sync.WaitGroup
)

func dispatch(env envelope) {
	switch env.Method {
	case "initialize":
		reply(env.ID, map[string]any{
			"protocolVersion": "2.0",
			"server_info":     map[string]any{"name": manifest["display_name"], "version": version},
			"capabilities":    map[string]any{"sampling": map[string]any{}},
		})
	case "describe":
		reply(env.ID, json.RawMessage(compactManifest))
	case "health":
		reply(env.ID, map[string]any{"status": "ready", "version": version})
	case "invoke":
		var p invokeParams
		_ = json.Unmarshal(env.Params, &p)
		tool := firstNonEmpty(p.Tool, p.Method, p.Name)
		args := p.Arguments
		if args == nil {
			args = p.Args
		}
		// Run invokes concurrently so the reader keeps routing sampling replies.
		inflight.Add(1)
		go func(id json.RawMessage) {
			defer inflight.Done()
			reply(id, invoke(tool, args))
		}(env.ID)
	case "shutdown":
		reply(env.ID, map[string]any{})
	default:
		if strings.HasPrefix(env.Method, "notifications/") {
			return
		}
		replyError(env.ID, -32601, "unknown rpc: "+env.Method)
	}
}

func firstNonEmpty(xs ...string) string {
	for _, x := range xs {
		if x != "" {
			return x
		}
	}
	return ""
}

var compactManifest []byte

func main() {
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		logf("bad embedded manifest: %v", err)
		os.Exit(1)
	}
	if v, ok := manifest["version"].(string); ok {
		version = v
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, manifestJSON); err != nil {
		logf("bad embedded manifest: %v", err)
		os.Exit(1)
	}
	compactManifest = buf.Bytes()

	if len(os.Args) > 1 && (os.Args[1] == "--version" || os.Args[1] == "-v") {
		fmt.Println("hearthside-kesiel", version)
		return
	}
	logf("Kesiel %s ready", version)

	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var env envelope
		if err := json.Unmarshal(line, &env); err != nil {
			logf("ignoring non-JSON line")
			continue
		}
		if env.Method == "" && len(env.ID) > 0 { // a reply to one of our sampling requests
			pendingMu.Lock()
			ch := pending[idKey(env.ID)]
			pendingMu.Unlock()
			if ch != nil {
				ch <- env
			}
			continue
		}
		dispatch(env)
	}
	if err := sc.Err(); err != nil {
		logf("stdin read error: %v", err)
	}
	close(stdinClosed)
	inflight.Wait()
}
