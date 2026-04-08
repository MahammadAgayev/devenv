return {
    "nvim-treesitter/nvim-treesitter",
    build = ":TSUpdate",
    config = function()
        require("nvim-treesitter").setup({
            ensure_installed = {
                "vimdoc", "javascript", "typescript", "c", "lua", "rust",
                "jsdoc", "bash", "zig",
            },
            auto_install = true,
        })

        -- Disable treesitter for html and large files
        vim.api.nvim_create_autocmd("FileType", {
            callback = function(args)
                local buf = args.buf
                local ft = vim.bo[buf].filetype
                if ft == "html" then
                    vim.treesitter.stop(buf)
                    return
                end
                local max_filesize = 100 * 1024 -- 100 KB
                local ok, stats = pcall(vim.uv.fs_stat, vim.api.nvim_buf_get_name(buf))
                if ok and stats and stats.size > max_filesize then
                    vim.notify(
                        "File larger than 100KB, treesitter disabled for performance",
                        vim.log.levels.WARN,
                        { title = "Treesitter" }
                    )
                    vim.treesitter.stop(buf)
                end
            end,
        })

        -- templ custom parser
        local ok, parser_config = pcall(require, "nvim-treesitter.parsers")
        if ok then
            parser_config.get_parser_configs().templ = {
                install_info = {
                    url = "https://github.com/vrischmann/tree-sitter-templ.git",
                    files = { "src/parser.c", "src/scanner.c" },
                    branch = "master",
                },
            }
        end

        vim.treesitter.language.register("templ", "templ")
    end,
}
