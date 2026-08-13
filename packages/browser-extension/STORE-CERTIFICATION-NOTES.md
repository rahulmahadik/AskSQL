# Notes for Certification

Paste the section below into **Submission Options > Notes for Certification** when resubmitting to the
Microsoft Edge Add-ons store. It answers policy 1.3.1 (Product is Testable), which the 08/13/2026
review flagged. Product ID: 248cd48a-7dbe-4cfd-8ec0-df1e07231acd

---

Product ID: 248cd48a-7dbe-4cfd-8ec0-df1e07231acd

**Why no test account credentials are provided**

AskSQL has no accounts, no sign-in, and no server of our own. Nothing is hosted by us, so there is no
credential we could issue. The extension stores its settings locally and talks only to two things the
user chooses: their own data files, and their own AI model provider.

Because of that, testing needs no credentials from us. It needs a model provider and a data file, and
both can be supplied at no cost in a few minutes.

**Fastest way to test, with no API key and no account (about 5 minutes)**

1. Install Ollama from https://ollama.com (free, no account required) and run:
   `ollama pull qwen2.5-coder:7b`
2. Start Ollama with `OLLAMA_ORIGINS=* ollama serve` so it serves on http://127.0.0.1:11434.
   The variable matters: fetching the model list works without it, but asking a question fails with
   403, because Ollama rejects the extension's origin on POST requests.
3. Open the extension's Options page, choose provider **Ollama**, click **Fetch models**, pick the
   model, and click **Test provider**. It should report success.
4. Add a connection: click **Add connection**, choose **Data files**, and select any CSV or Excel
   file. Any small spreadsheet works; no database server is needed.
5. Open the side panel and ask a question about the file, for example "how many rows are there?" or
   "show me the first 10 records".

**Alternative, if you prefer a hosted provider**

Any OpenAI, Anthropic or Groq API key works. Enter it in the Options page under the matching provider
and follow steps 3 to 5 above. We cannot include one of our keys in this submission, because the key
would be visible to anyone who reads the listing and would be billed to us.

**What the extension sends where**

Questions and database schema go only to the provider the user configures, over a connection they
control. Data files are read in the browser and never uploaded to us. The extension has no analytics
and no backend. Generated SQL is read-only and is checked before it runs, so a query cannot modify
the user's data.

**If anything blocks the review**

Please include the Product ID in any reply and we will respond quickly with whatever else is helpful,
including a recorded walkthrough if that is easier than running it locally.
