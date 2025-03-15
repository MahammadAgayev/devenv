return {
  "jose-elias-alvarez/null-ls.nvim",
  dependencies = { "nvim-lua/plenary.nvim" },
  config = function()
    local null_ls = require("null-ls")
    local util = require("lspconfig.util")
    local function get_first_value(obj)
        for _, value in pairs(obj) do
                return value
        end
    end

    local arc_lint = {
        method = null_ls.methods.DIAGNOSTICS,
        filetypes = { "go"}, 
        generator = null_ls.generator({
            command = "arc",
            args = { "lint", "--output", "json", "$FILENAME" },
            -- to_temp_file = true, -- Ensures file is passed correctly
            format = "json",
            from_stderr = false,
            ignore_stderr = true,
            multiple_files = false,
            on_output = function(params)
                local diagnostics = {}

                if not params.output then
                    return diagnostics
                end

                for _, err in ipairs(get_first_value(params.output)) do
                    table.insert(diagnostics, {
                        row = err["line"] or 1,
                        col = err["char"] or 1,
                        message = err["description"] or "Unknown lint error",
                        severity = err["severity"] == "error" and vim.diagnostic.severity.ERROR
                            or vim.diagnostic.severity.WARN,
                        source = "arc lint"
                    })
                end

                return diagnostics
            end
        })
    }

    null_ls.register(arc_lint)
    null_ls.setup({
        root_dir = util.root_pattern(".arcconfig"),
    })
  end
}
