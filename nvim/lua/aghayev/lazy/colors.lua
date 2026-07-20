local transparent_hls = {
	"Normal", "NormalFloat", "NormalNC", "EndOfBuffer", "SignColumn",
	"DiffAdd", "DiffChange", "DiffDelete", "DiffText",
}

local function apply_transparency()
	for _, group in ipairs(transparent_hls) do
		vim.api.nvim_set_hl(0, group, { bg = "none" })
	end
end

vim.api.nvim_create_autocmd("ColorScheme", {
	callback = apply_transparency,
})

function ColorMyPencils(color)
	color = color or "rose-pine-moon"
	vim.cmd.colorscheme(color)
	apply_transparency()
end

return {

    {
        "erikbackman/brightburn.vim",
    },

    {
        "ellisonleao/gruvbox.nvim",
        name = "gruvbox",
        config = function()
            require("gruvbox").setup({
                terminal_colors = true, -- add neovim terminal colors
                undercurl = true,
                underline = false,
                bold = true,
                italic = {
                    strings = false,
                    emphasis = false,
                    comments = false,
                    operators = false,
                    folds = false,
                },
                strikethrough = true,
                invert_selection = false,
                invert_signs = false,
                invert_tabline = false,
                invert_intend_guides = false,
                inverse = true, -- invert background for search, diffs, statuslines and errors
                contrast = "", -- can be "hard", "soft" or empty string
                palette_overrides = {},
                overrides = {},
                dim_inactive = false,
                transparent_mode = false,
            })
        end,
    },
    {
        "folke/tokyonight.nvim",
        lazy = false,
        config = function()
            require("tokyonight").setup({
                style = "storm",
                transparent = true,
                terminal_colors = true,
                styles = {
                    comments = { italic = false },
                    keywords = { italic = false },
                    sidebars = "dark",
                    floats = "dark",
                },
                on_colors = function(colors)
                    colors.orange = "#F7A41D"
                    colors.yellow = "#F7A41D"
                end,
                on_highlights = function(hl, c)
                    hl.Function = { fg = "#F7A41D", bold = true }
                    hl.Type = { fg = "#e0af68" }
                    hl["@keyword"] = { fg = "#bb9af7" }
                    hl["@variable.builtin"] = { fg = "#F7A41D" }
                end,
            })
        end
    },

    {
        "rose-pine/neovim",
        name = "rose-pine",
        config = function()
            require('rose-pine').setup({
                disable_background = true,
                styles = {
                    italic = false,
                },
                highlight_groups = {
                    Normal = { bg = "none" },
                    NormalNC = { bg = "none" },
                    NormalFloat = { bg = "none" },
                    EndOfBuffer = { bg = "none" },
                    SignColumn = { bg = "none" },
                },
            })

            ColorMyPencils();
        end
    },


}
