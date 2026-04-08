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
        picker = { enabled = true },
        words = { enabled = true },
    },
    keys = {
        -- Grep
        { "<leader>ps", function() Snacks.picker.grep() end, desc = "Grep" },
        { "<leader>pw", function() Snacks.picker.grep_word() end, desc = "Grep Word", mode = { "n", "x" } },
        -- Notifications
        { "<leader>nc", function() Snacks.notifier.hide() end, desc = "Dismiss Notifications" },
        { "<leader>nh", function() Snacks.picker.notifications() end, desc = "Notification History" },
        -- Word references
        { "]]", function() Snacks.words.jump(vim.v.count1) end, desc = "Next Reference", mode = { "n", "t" } },
        { "[[", function() Snacks.words.jump(-vim.v.count1) end, desc = "Prev Reference", mode = { "n", "t" } },
    },
}
