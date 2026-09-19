# AI marking proxy

`marking-worker.js` is a Cloudflare Worker that sits between the app and OpenRouter. It keeps the OpenRouter key out of the web page, picks the model for each kind of marking, and only accepts requests from the app's own site.

| Marking | Model |
|---|---|
| Speaking (the recording itself) | `google/gemini-3.8-flash` |
| Write Essay | `anthropic/claude-sonnet-5` |
| Summarize Written Text, Summarize Spoken Text | `anthropic/claude-haiku-4.5` |

To change a model, edit `MODELS` at the top of the file and deploy again. The app doesn't need changing.

## One-time setup

### 1. A dedicated OpenRouter key with a spending limit

1. Sign in at openrouter.ai, go to **Settings → API Keys**, and choose **Create Key**.
2. Name it `PTE Score Lab` and set a **credit limit** (e.g. $5). This limit is the hard cap on what the site can spend.
3. Copy the key. You will paste it into Cloudflare in step 3, and nowhere else.

### 2. Create the Worker

1. Sign up for free at dash.cloudflare.com.
2. Go to **Workers & Pages → Create → Create Worker**, name it `pte-marking`, and click **Deploy**.
3. Click **Edit code**, delete everything in the editor, and paste in the whole of `marking-worker.js`. Click **Deploy**.

### 3. Add the key as a secret

1. In the Worker, open **Settings → Variables and Secrets → Add**.
2. Set the type to **Secret**, the name to `OPENROUTER_API_KEY_PTE`, and paste the key as the value.
3. Click **Deploy**.

### 4. Connect the app

Copy the Worker's address. It looks like `https://pte-marking.<your-name>.workers.dev`. The app's `MARK_URL_DEFAULT` in `index.html` is set to this address.

## Notes

- **Recordings aren't stored.** The Worker passes each recording straight to OpenRouter and keeps nothing.
- **Only the app's own site can use the Worker.** Requests from any other site are refused. To test from another address, add a plain variable `ALLOWED_ORIGINS` with that address, e.g. `http://127.0.0.1:8765`.
- **Optional per-visitor limit.** Attach a Rate Limiting binding named `LIMITER` and the Worker will enforce it. Without one, the OpenRouter credit limit is the cap.
