return {
  "carderne/pi-nvim",
  config = function()
    require("pi-nvim").setup({ set_default_keymaps = false })

    vim.keymap.set({ "n", "v" }, "<leader>aa", "<cmd>Pi<CR>",             { desc = "Pi dialog" })
    vim.keymap.set("n",          "<leader>af", "<cmd>PiSendFile<CR>",      { desc = "Pi send file" })
    vim.keymap.set("v",          "<leader>as", "<cmd>PiSendSelection<CR>", { desc = "Pi send selection" })
    vim.keymap.set("n",          "<leader>ab", "<cmd>PiSendBuffer<CR>",    { desc = "Pi send buffer" })
    vim.keymap.set("n",          "<leader>ap", "<cmd>PiSend<CR>",          { desc = "Pi prompt" })
    vim.keymap.set("n",          "<leader>ai", "<cmd>PiPing<CR>",          { desc = "Pi ping" })
    vim.keymap.set("n",          "<leader>al", "<cmd>PiSessions<CR>",      { desc = "Pi sessions" })
  end,
}
