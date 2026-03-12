return {
    "greggh/claude-code.nvim",
    dependencies = {
        "nvim-lua/plenary.nvim",
    },
    config = function()
        require("claude-code").setup({
            -- Command configuration
            command = "aifx agent run claude",

            -- Window configuration
            window = {
                split_ratio = 0.38, -- dont' judge me:)
                position = "rightbelow vsplit",
                enter_insert = true,
                hide_numbers = true,
                hide_signcolumn = true,
                float = {
                    width = "80%",
                    height = "80%",
                    row = "center",
                    col = "center",
                    relative = "editor",
                    border = "rounded",
                },
            },

            -- File refresh configuration
            file_refresh = {
                enable = true,
                updatetime = 300,
                show_notifications = true,
            },

            -- Git integration
            git = {
                use_git_root = false,  -- Use Neovim's cwd instead of git root
            },
        })

        -- Key mappings
        vim.keymap.set("n", "<leader>cc", ":ClaudeCode<CR>", { desc = "Toggle Claude Code terminal" })
        vim.keymap.set("t", "<leader>cc", "<C-\\><C-n>:ClaudeCode<CR>", { desc = "Toggle Claude Code terminal" })
        vim.keymap.set("n", "<leader>cC", ":ClaudeCodeContinue<CR>", { desc = "Continue Claude Code conversation" })
        vim.keymap.set("n", "<leader>cV", ":ClaudeCodeResume<CR>", { desc = "Resume Claude Code conversation" })
    end
}
