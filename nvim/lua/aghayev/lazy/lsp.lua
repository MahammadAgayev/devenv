return {
    "neovim/nvim-lspconfig",
    dependencies = {
        "stevearc/conform.nvim",
        "williamboman/mason.nvim",
        "williamboman/mason-lspconfig.nvim",
        "hrsh7th/cmp-nvim-lsp",
        "hrsh7th/cmp-buffer",
        "hrsh7th/cmp-path",
        "hrsh7th/cmp-cmdline",
        "hrsh7th/nvim-cmp",
        "L3MON4D3/LuaSnip",
        "saadparwaiz1/cmp_luasnip",
        "j-hui/fidget.nvim",
    },

    config = function()
        require("conform").setup({
            formatters_by_ft = {
            }
        })
        local cmp = require('cmp')
        local cmp_lsp = require("cmp_nvim_lsp")
        local capabilities = vim.tbl_deep_extend(
            "force",
            {},
            vim.lsp.protocol.make_client_capabilities(),
            cmp_lsp.default_capabilities())

        vim.lsp.config.ulsp = {
            cmd = { "socat", "-", "tcp:localhost:27883,ignoreeof" },
            flags = {
                debounce_text_changes = 1000,
            },
            capabilities = vim.lsp.protocol.make_client_capabilities(),
            filetypes = { "go", "java" },
            root_dir = function(fname)
                local result = vim.system({ "git", "rev-parse", "--show-toplevel" }, { text = true }):wait()
                if result.code == 0 and result.stdout then
                    return vim.trim(result.stdout)
                end
                return vim.fs.root(fname, ".git")
            end,
        }

        vim.lsp.enable('ulsp')

        require("fidget").setup({})
        require("mason").setup({})
        require("mason-lspconfig").setup({
            ensure_installed = {
                "lua_ls",
                "gopls",
                "pylsp",
                "zls",
            },
            automatic_enable = false,
        })

        vim.lsp.config.pylsp = {
            cmd = { 'pylsp' },
            filetypes = { 'python' },
            root_dir = vim.fs.root(0, {'.git', 'pyproject.toml', 'setup.py'}),
            capabilities = capabilities,
            settings = {
                pylsp = {
                    plugins = {
                        pycodestyle = {
                            ignore = {'E501'}, -- This is the Error code for line too long.
                            maxLineLength = 200 -- This sets how long the line is allowed to be. Also has effect on formatter.
                        },
                    },
                }
            }
        }

        vim.lsp.config.lua_ls = {
            cmd = { 'lua-language-server' },
            filetypes = { 'lua' },
            root_dir = vim.fs.root(0, {'.git', '.luarc.json', '.luarc.jsonc'}),
            capabilities = capabilities,
            settings = {
                Lua = {
                    runtime = { version = "Lua 5.1" },
                    diagnostics = {
                        globals = { "bit", "vim", "it", "describe", "before_each", "after_each" },
                    }
                }
            }
        }

        vim.lsp.config.gopls = {
            cmd = { 'gopls' },
            filetypes = { 'go', 'gomod', 'gowork', 'gotmpl' },
            root_dir = vim.fs.root(0, {'.git'}),
            capabilities = capabilities,
        }

        vim.lsp.config.zls = {
            cmd = { 'zls' },
            filetypes = { 'zig', 'zir' },
            root_dir = vim.fs.root(0, { 'build.zig', 'build.zig.zon', '.git' }),
            capabilities = capabilities,
        }

        vim.lsp.enable('pylsp')
        vim.lsp.enable('lua_ls')
        vim.lsp.enable('gopls')
        vim.lsp.enable('zls')

        local cmp_select = { behavior = cmp.SelectBehavior.Select }

        vim.diagnostic.config({
            virtual_text = true,
            signs = true,
            underline = true,
            update_in_insert = false,
            severity_sort = true,
            float = {
                focusable = false,
                style = "minimal",
                border = "rounded",
                source = "always",
                header = "",
                prefix = "",
            },
        })
    end
}
