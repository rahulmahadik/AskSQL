# Notes for Certification

Paste the block below into **Submission Options > Notes for Certification** every time the extension is
submitted or resubmitted. This field is **private to the review team** and is not shown on the public
listing, so a temporary API key can safely go in it.

The 08/13/2026 and 08/18/2026 reviews both flagged policy 1.3.1 (Product is Testable) with identical
wording. The cause was not the wording of these notes: the field reaching Microsoft did not contain
them. The release workflow can send them automatically, but its Edge upload step is gated behind
`EDGE_PUBLISH_ENABLED` and has never run, so every submission so far has been manual. If the field is
filled in by hand, it must be filled in with this.

## Before submitting

1. Create a **free Groq API key** at <https://console.groq.com> (no card required) and paste it into
   the block below where it says `PASTE_KEY_HERE`. Groq's free tier is rate limited and costs nothing.
2. Note the date you created it. **Revoke it once the review completes** - it exists only for the
   reviewer.
3. Do not reuse a key that has billing attached, and never commit a real key to this file.
4. Confirm the model named below still exists: `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $KEY"`.
   Providers retire models without notice - Groq removed every Llama chat model, and the name previously
   printed here answered 404, which would read to a reviewer as a product that does not work.

---

Product ID: 248cd48a-7dbe-4cfd-8ec0-df1e07231acd

**Test credentials**

AskSQL has no accounts and no sign-in, so there is no account to issue. What it does need is an AI
provider, which the user supplies. So that the review does not depend on you creating one, here is a
temporary key we created for this submission and will revoke afterwards:

    Provider: Groq
    API key:  PASTE_KEY_HERE

Nothing else is needed. There is no database to connect to for this test, no server of ours, and
nothing to install.

**Test it in about two minutes**

1. Save these six lines as `sales.csv` anywhere on the machine:

        id,customer,region,amount
        1,Ada,EU,1200.50
        2,Grace,NA,980.00
        3,Kat,NA,1500.25
        4,Ada,EU,300.00
        5,Linus,APAC,75.99

2. Click the AskSQL toolbar icon to open the side panel, then open **Settings**.
3. Under **AI provider**, choose **Groq**, paste the key above, click **Fetch models**, pick
   `openai/gpt-oss-20b`, and click **Test provider**. It reports success.
4. Under **Connections**, click **Add connection**, choose **Data files**, and select `sales.csv`.
   The file is read inside the browser into DuckDB-WASM; nothing is uploaded.
5. In the side panel, ask: **"What is the total amount per region?"**
   You should see the SQL it wrote, and a result of three rows: EU 1500.50, NA 2480.25, APAC 75.99.

Asking "delete all rows" is a good second test: the extension refuses it, because the generated SQL is
checked and only read-only statements are allowed to run.

**If you prefer to use no key at all**

Steps 1, 2 and 4 work with no provider configured and no network access: the file loads, the tables
and columns are listed, and the UI is fully exercised. Only step 5, which needs a model, requires the
key. A local model also works: install Ollama from ollama.com, run `ollama pull qwen2.5-coder:7b`, and
choose provider **Ollama** with base URL `http://localhost:11434/v1` and no key.

**Permissions**

Host permissions are optional and requested per site, only when the tester configures an AI endpoint or
an AskSQL server at that address. They are never requested up front.

`declarativeNetRequestWithHostAccess` is used for exactly one purpose: removing the `Origin` header
from requests to the AI endpoint the user configured. Local AI servers such as Ollama and LM Studio
reject a `chrome-extension://` origin by default, which would otherwise make the extension unusable
with a local model. The rule removes a header. It never adds, forges, blocks or redirects anything, and
never applies to any other address. PRIVACY.md in the package documents this.

**Data handling**

No analytics, no telemetry, and no server operated by us. Only the schema - table and column names -
and the question the user typed are sent to the AI endpoint the user chose. Row data and query results
are never sent. Data files are read in the browser and never uploaded.

**If anything blocks the review**

Please include the Product ID in any reply. We will respond quickly with whatever helps, including a
recorded walkthrough if that is easier than running it.
