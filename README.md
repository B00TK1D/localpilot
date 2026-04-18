# localpilot

Use local models for Github Copilot

Start the proxy:

```bash
docker compose up --build
```

Install `copilot.nvim`:

https://github.com/github/copilot.vim

Point Copilot at the proxy before starting Neovim:

```bash
export GH_COPILOT_OVERRIDE_PROXY_URL=http://127.0.0.1:8080
```

AI Usage Disclaimer: this was mostly written by GPT-5.4 in the OpenCode harness.
