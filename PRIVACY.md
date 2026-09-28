# Privacy

Instagram Comment Desk runs entirely in your browser. It has no server, no analytics, and loads no remote code.

To show and reply to comments, it calls Instagram's own web endpoints on instagram.com using the session you're already logged in with, the same way the Instagram website does. It reads the `csrftoken` and `ds_user_id` cookies only to authenticate those requests and to tell whether a post is yours.

It stores the following locally in `chrome.storage.local` (not synced):

- Your settings (auto-open, wide view, quick replies)
- Which comments you marked "Done" or replied to, keyed by post ID

Removing the extension removes this data.
