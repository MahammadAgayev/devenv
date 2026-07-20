return {
    "folke/snacks.nvim",
    priority = 1000,
    lazy = false,
    ---@type snacks.Config
    opts = {
        notifier = {
            enabled = true,
            timeout = 3000,
        },
        picker = {
            enabled = true,
            layout = { border = "none" },
        },
        words = { enabled = true },
    },
    keys = {
        -- Files
        { "<leader>pf", function() Snacks.picker.files() end, desc = "Find Files" },
        { "<C-p>", function() Snacks.picker.git_files() end, desc = "Git Files" },
        { "<leader>pb", function() Snacks.picker.buffers() end, desc = "Buffers" },
        -- Grep
        { "<leader>ps", function() Snacks.picker.grep() end, desc = "Grep" },
        { "<leader>pw", function() Snacks.picker.grep_word() end, desc = "Grep Word", mode = { "n", "x" } },
        { "<leader>pws", function() Snacks.picker.grep({ search = vim.fn.expand("<cword>") }) end, desc = "Grep cword" },
        { "<leader>pWs", function() Snacks.picker.grep({ search = vim.fn.expand("<cWORD>") }) end, desc = "Grep cWORD" },
        -- Help
        { "<leader>vh", function() Snacks.picker.help() end, desc = "Help Tags" },
        -- Notifications
        { "<leader>nc", function() Snacks.notifier.hide() end, desc = "Dismiss Notifications" },
        { "<leader>nh", function() Snacks.picker.notifications() end, desc = "Notification History" },
        -- Word references
        { "]]", function() Snacks.words.jump(vim.v.count1) end, desc = "Next Reference", mode = { "n", "t" } },
        { "[[", function() Snacks.words.jump(-vim.v.count1) end, desc = "Prev Reference", mode = { "n", "t" } },
    },
}
