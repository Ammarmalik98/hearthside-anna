# Hearthside Privacy Policy

**Effective date:** October 28, 2026
**App:** Hearthside, a journal app for the Anna AI OS
**Developer:** Ammar Malik — contact: ammarmal33k@gmail.com

Hearthside is a private journal. This policy explains, in plain language, what the app stores, what it sends to AI, and what control you have. In short: your journal lives in your own Anna account, Hearthside has no servers of its own, and nothing is used for advertising.

## 1. What Hearthside stores

When you use Hearthside inside Anna, the app saves the following to **your Anna account**, using Anna's app storage:

- **Your entries:** title, text and formatting, any photos you add, the date, the mood you picked, your tags, and word counts.
- **Kesiel's notes:** the short reflection and follow-up question Kesiel writes about an entry, saved with that entry.
- **Your settings:** the name you want Kesiel to use, theme, page style and font, your daily reminder time and days, and whether reflections are on.
- **Your privacy lock, if you set one:** a one-way hash of your password (never the password itself) and the hint you chose.

This data is kept so the journal is there on every device where you sign in to Anna. It stays until you delete it (see section 6).

If you open Hearthside outside Anna (for example, a developer preview in a plain web browser), the same information is kept only in that browser's local storage on that device.

## 2. What is sent to AI, and when

Kesiel, the app's companion, uses **Anna's built-in AI**. Text is sent to it only when you take one of these actions:

| When you… | What is sent |
| --- | --- |
| Save an entry with reflections switched on (entries of at least a few lines) | That entry's text, title and mood, the name you gave Kesiel, and short excerpts (date, title, mood, first ~160 characters) of your three most recent other entries |
| Tap **Another thought** on a reflection | The same as above, for that entry |
| Tap the **✦** prompt button | Short excerpts of your three most recent entries |
| Ask Kesiel a question in the chat | Your question, your recent chat messages, and a digest of your journal: each entry's date, title, mood, tags, word count and its first ~240 characters, newest first, up to a size limit |

**Photos are never sent to the AI.** Only text is.

You can switch reflections off at any time in **Settings → Kesiel**. If you never save with reflections on, never use the ✦ button and never use the chat, none of your writing is sent to AI.

Anna runs these AI requests on its platform, and Anna may use third-party model providers to do so. If you use your own model key with Anna ("bring your own key"), requests may go to that key's provider. How Anna and those providers handle AI requests is covered by **Anna's own privacy policy and terms** (available on anna.partners). Hearthside does not ask for your journal to be used to train AI models.

## 3. What the developer can see

Hearthside has no servers, database or analytics of its own. The app's code runs inside Anna, and your data goes only to Anna (section 1) and Anna's AI (section 2).

As the developer, I do not receive copies of your entries, settings or chat messages. Anna may show developers aggregate usage statistics for their apps (for example, how many people used the app in a month). Those statistics come from Anna, and they don't include the content of your journal.

## 4. Reminders and notifications

If you turn on the daily reminder, the reminder time and days are saved in your settings. Reminders are shown by your browser or device while Hearthside is open. There is no push-notification server. Reminder text is a general writing prompt and never contains your journal content.

**Add to my calendar** creates a calendar file on your device containing only the reminder title, time and days. Hearthside does not connect to your calendar account; what happens after you import the file is up to your calendar app.

## 5. Backups

**Download backup** creates a file on your device containing your entries (including photos) and settings. Your password hash and hint are left out. The file is not encrypted, so keep it somewhere safe. **Restore from backup** reads a file you choose and adds its entries to your journal.

## 6. Your choices and control

- **See and edit your data:** everything Hearthside stores is visible in the app, and you can edit or delete any entry.
- **Take your data with you:** Download backup at any time.
- **Delete everything:** Settings → Start over → **Erase everything** deletes all entries and settings from your journal, on every device. A backup file you downloaded is not affected.
- **Stop AI processing:** switch off reflections and don't use the chat or ✦ button.

Removing the app from Anna may not by itself delete its stored data, so use **Erase everything** first if you want your journal gone. For your Anna account itself, see Anna's policies.

## 7. Security

Your data is protected by your Anna account and Anna's platform security. The optional privacy lock is a screen lock that keeps casual eyes off your pages. **It is not encryption**: your entries are not encrypted by Hearthside, and the lock doesn't stop someone who has access to your Anna account. Use a strong Anna password and keep your devices locked.

## 8. Cookies, tracking and advertising

Hearthside uses no cookies, ads, trackers or third-party analytics. Its fonts and images are bundled with the app, so opening it doesn't contact other websites. Hearthside never sells or shares your data.

## 9. Children

Hearthside is not directed at children under 13, and the developer does not knowingly collect information from them.

## 10. Changes to this policy

If this policy changes, the updated version will be posted at this address with a new effective date. Significant changes will also be mentioned in the app's release notes.

## 11. Contact

Questions or requests about your privacy: **[your-email@example.com]**
