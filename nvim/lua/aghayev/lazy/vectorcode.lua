return {
  {
    "Davidyz/VectorCode",
    dependencies = { "nvim-lua/plenary.nvim" },
    config = function()
      require("vectorcode").setup({
        n_query = 10,
        notify = true,
        timeout_ms = 5000
      })
    end
  },
}