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

        require("lspconfig.configs").ulsp = {
            default_config = {
                cmd = { "socat", "-", "tcp:localhost:27883,ignoreeof" },
                flags = {
                    debounce_text_changes = 1000,
                },
                capabilities = vim.lsp.protocol.make_client_capabilities(),
                filetypes = { "go", "java" },
                root_dir = function(fname)
                    local result = require("lspconfig.async").run_command({ "git", "rev-parse", "--show-toplevel" })
                    if result and result[1] then
                        return vim.trim(result[1])
                    end
                    return require("lspconfig.util").root_pattern(".git")(fname)
                end,
                single_file_support = false,
                docs = {
                    description = [[
  uLSP brought to you by the IDE team!
  By utilizing uLSP in Neovim, you acknowledge that this integration is provided 'as-is' with no warranty, express or implied.
  We make no guarantees regarding its functionality, performance, or suitability for any purpose, and absolutely no support will be provided.
  Use at your own risk, and may the code gods have mercy on your soul
]],
                },
            },
        }

        local lspconfig = require("lspconfig")

        lspconfig['ulsp'].setup({})
        require("fidget").setup({})
        require("mason").setup({})
        require("mason-lspconfig").setup({
            ensure_installed = {
                "lua_ls",
                "gopls",
                "pylsp",
            },
            automatic_enable = false,
        })

        lspconfig.pylsp.setup {
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

        lspconfig.lua_ls.setup {
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

        lspconfig.gopls.setup {
            capabilities = capabilities,
            root_dir = lspconfig.util.root_pattern(".git"),
        }

        local cmp_select = { behavior = cmp.SelectBehavior.Select }

        cmp.setup({
            snippet = {
                expand = function(args)
                    require('luasnip').lsp_expand(args.body) -- For `luasnip` users.
                end,
            },
            mapping = cmp.mapping.preset.insert({
                ['<C-p>'] = cmp.mapping.select_prev_item(cmp_select),
                ['<C-n>'] = cmp.mapping.select_next_item(cmp_select),
                ['<C-y>'] = cmp.mapping.confirm({ select = true }),
                ["<C-Space>"] = cmp.mapping.complete(),
            }),
            sources = cmp.config.sources({
                { name = 'nvim_lsp' },
                { name = 'luasnip' }, -- For luasnip users.
            }, {
                { name = 'buffer' },
            })
        })

        vim.diagnostic.config({
            -- update_in_insert = true,
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
