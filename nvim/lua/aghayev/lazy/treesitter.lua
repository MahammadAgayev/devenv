return {
    "nvim-treesitter/nvim-treesitter",
    branch = "main",
    lazy = false,
    build = ":TSUpdate",
    config = function()
        local ts = require("nvim-treesitter")

        ts.setup({})

        vim.treesitter.language.register("templ", "templ")

        ts.install({
            "vimdoc", "javascript", "typescript", "c", "lua", "rust",
            "jsdoc", "bash", "zig", "templ", "java",
        })

        local max_filesize = 100 * 1024 -- 100 KB

        -- main branch has no highlight module; Neovim drives highlighting
        vim.api.nvim_create_autocmd("FileType", {
            callback = function(args)
                local buf = args.buf
                local ft = vim.bo[buf].filetype
                if ft == "html" then
                    return
                end

                local ok, stats = pcall(vim.uv.fs_stat, vim.api.nvim_buf_get_name(buf))
                if ok and stats and stats.size > max_filesize then
                    vim.notify(
                        "File larger than 100KB, treesitter disabled for performance",
                        vim.log.levels.WARN,
                        { title = "Treesitter" }
                    )
                    return
                end

                local lang = vim.treesitter.language.get_lang(ft)
                if not lang then
                    return
                end

                if vim.tbl_contains(ts.get_installed("parsers"), lang) then
                    pcall(vim.treesitter.start, buf, lang)
                elseif vim.tbl_contains(ts.get_available(), lang) then
                    -- auto_install replacement
                    ts.install({ lang }):await(function()
                        if vim.api.nvim_buf_is_valid(buf) then
                            pcall(vim.treesitter.start, buf, lang)
                        end
                    end)
                end
            end,
        })
    end,
}
