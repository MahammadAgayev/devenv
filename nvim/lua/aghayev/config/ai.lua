local utils = require('aghayev.config.utils')
local icons = require('aghayev.config.icons')
utils.desc('<leader>a', 'AI')

-- Copilot inline suggestions disabled (CopilotChat still works)
vim.g.copilot_filetypes = { ["*"] = false }
vim.g.copilot_proxy_strict_ssl = false
vim.g.copilot_integration_id = 'vscode-chat'

-- Copilot chat
local chat = require('CopilotChat')
local select = require('CopilotChat.select')
local providers = require('CopilotChat.config.providers')
local cutils = require('CopilotChat.utils')

local COPILOT_PLAN = [[
You are a software architect and technical planner focused on clear, actionable development plans.

When creating development plans:
- Start with a high-level overview
- Break down into concrete implementation steps
- Identify potential challenges and their solutions
- Consider architectural impacts
- Note required dependencies or prerequisites
- Estimate complexity and effort levels
- Track confidence percentage (0-100%)
- Format in markdown with clear sections

Always end with:
"Current Confidence Level: X%"
"Would you like to proceed with implementation?" (only if confidence >= 90%)
]]

-- VectorCode
-- local vectorcode_ctx = require('vectorcode.integrations.copilotchat').make_context_provider({
--   prompt_header = "Here are relevant files from the repository:", -- Customize header text
--   prompt_footer = "\nConsider this context when answering:", -- Customize footer text
--   skip_empty = true, -- Skip adding context when no files are retrieved
-- })

chat.setup({
    model = 'claude-3.7-sonnet',
    references_display = 'write',
    question_header = ' ' .. icons.ui.User .. ' ',
    answer_header = ' ' .. icons.ui.Bot .. ' ',
    error_header = '> ' .. icons.diagnostics.Warn .. ' ',
    selection = select.visual,
    context = 'buffers',
    mappings = {
        reset = false,
        show_diff = {
            full_diff = true,
        },
    },
    prompts = {
        Explain = {
            mapping = '<leader>ae',
            context = { "selection"},
            description = 'AI Explain',
        },
        Review = {
            mapping = '<leader>ar',
            description = 'AI Review',
        },
        Tests = {
            mapping = '<leader>at',
            description = 'AI Tests',
        },
        Fix = {
            mapping = '<leader>af',
            description = 'AI Fix',
        },
        Optimize = {
            mapping = '<leader>ao',
            description = 'AI Optimize',
        },
        Docs = {
            mapping = '<leader>ad',
            description = 'AI Documentation',
        },
        Commit = {
            mapping = '<leader>ac',
            description = 'AI Generate Commit',
            selection = select.buffer,
        },
        Plan = {
            prompt = "Create or update the development plan for the selected code. Focus on architecture, implementation steps, and potential challenges.",
            system_prompt = COPILOT_PLAN,
            context = 'file:.copilot/plan.md',
            progress = function()
                return false
            end,
            callback = function(response, source)
                chat.chat:append('Plan updated successfully!', source.winnr)
                local plan_file = source.cwd() .. '/.copilot/plan.md'
                local dir = vim.fn.fnamemodify(plan_file, ':h')
                vim.fn.mkdir(dir, 'p')
                local file = io.open(plan_file, 'w')
                if file then
                    file:write(response)
                    file:close()
                end
            end
        },
    },
    contexts = {
    }
})

utils.au('BufEnter', {
    pattern = 'copilot-*',
    callback = function()
        vim.opt_local.relativenumber = false
        vim.opt_local.number = false
    end,
})

vim.keymap.set({ 'n' }, '<leader>aa', function() chat.toggle() end, { desc = 'AI Toggle' })
vim.keymap.set({ 'v' }, '<leader>aa', function() chat.open() end, { desc = 'AI Open' })
vim.keymap.set({ 'n' }, '<leader>ax', function() chat.reset() end, { desc = 'AI Reset' })
vim.keymap.set({ 'n' }, '<leader>as', function() chat.stop() end, { desc = 'AI Stop' })
vim.keymap.set({ 'n' }, '<leader>am', function() chat.select_model() end, { desc = 'AI Models' })
vim.keymap.set({ 'n' }, '<leader>ag', function() chat.select_agent() end, { desc = 'AI Agents' })
vim.keymap.set({ 'n', 'v' }, '<leader>ap', function() chat.select_prompt() end, { desc = 'AI Prompts' })
vim.keymap.set({ 'n', 'v' }, '<leader>aq', function()
    vim.ui.input({
        prompt = 'AI Question> ',
    }, function(input)
        if input ~= '' then
            chat.ask(input)
        end
    end)
end, { desc = 'AI Question' })


vim.keymap.set({ 'n' }, '<leader>alb', function()
    vim.cmd('vsplit')
    vim.cmd('wincmd l')
    vim.cmd('terminal claude "Explain this project"')
    vim.cmd('startinsert')
end, { desc = 'AI Claude CLI' })
