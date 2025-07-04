local utils = require('aghayev.config.utils')
local icons = require('aghayev.config.icons')
utils.desc('<leader>a', 'AI')

-- Copilot autosuggestions
vim.g.copilot_no_tab_map = true
vim.g.copilot_hide_during_completion = false
vim.g.copilot_proxy_strict_ssl = false
vim.g.copilot_integration_id = 'vscode-chat'
vim.g.copilot_settings = { selectedCompletionModel = 'gpt-4o-copilot' }
vim.keymap.set('i', '<S-Tab>', 'copilot#Accept("\\<S-Tab>")', { expr = true, replace_keycodes = false })

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
      vectorcode = {
        description = 'Uses VectorCode to search for semantically relevant content. Supports input (search query).',
        input = function(callback)
          vim.ui.input({
            prompt = 'Enter search query> ',
          }, callback)
        end,
        resolve = function(input, source, prompt)
          if not input or input == '' then
            input = prompt
          end
          
          local ok, vectorcode = pcall(require, 'vectorcode')
          if not ok then
            return {}
          end
          
          local results = vectorcode.query(input)
          if not results or #results == 0 then
            return {}
          end
          
          return vim.iter(results)
            :map(function(result)
              return {
                content = result.content or result.text,
                filename = result.filename or result.file,
                filetype = cutils.filetype(result.filename or result.file)
              }
            end)
            :filter(function(result)
              return result.filetype and result.content
            end)
            :totable()
        end,
      },
    },
    providers = {
        github_models = {
            disabled = true,
        },

        openrouter = {
            disabled = true,
            prepare_input = providers.copilot.prepare_input,
            prepare_output = providers.copilot.prepare_output,

            get_headers = function()
                local api_key = assert(os.getenv('OPENROUTER_API_KEY'), 'OPENROUTER_API_KEY environment variable not set')
                return {
                    Authorization = 'Bearer ' .. api_key,
                    ['Content-Type'] = 'application/json',
                }
            end,

            get_models = function(headers)
                local response, err = cutils.curl_get('https://openrouter.ai/api/v1/models', {
                    headers = headers,
                    json_response = true,
                })

                if err then
                    error(err)
                end

                return vim.iter(response.body.data)
                    :map(function(model)
                        return {
                            id = model.id,
                            name = model.name,
                        }
                    end)
                    :totable()
            end,

            get_url = function()
                return 'https://openrouter.ai/api/v1/chat/completions'
            end,
        },

        mistral = {
            disabled = true,
            prepare_input = providers.copilot.prepare_input,
            prepare_output = providers.copilot.prepare_output,

            get_headers = function()
                local api_key = assert(os.getenv('MISTRAL_API_KEY'), 'MISTRAL_API_KEY environment variable not set')
                return {
                    Authorization = 'Bearer ' .. api_key,
                    ['Content-Type'] = 'application/json',
                }
            end,

            get_models = function(headers)
                local response, err = cutils.curl_get('https://api.mistral.ai/v1/models', {
                    headers = headers,
                    json_response = true,
                })

                if err then
                    error(err)
                end

                return vim.iter(response.body.data)
                    :filter(function(model)
                        return model.capabilities.completion_chat
                    end)
                    :map(function(model)
                        return {
                            id = model.id,
                            name = model.name,
                        }
                    end)
                    :totable()
            end,

            embed = function(inputs, headers)
                local response, err = cutils.curl_post('https://api.mistral.ai/v1/embeddings', {
                    headers = headers,
                    json_request = true,
                    json_response = true,
                    body = {
                        model = 'mistral-embed',
                        input = inputs,
                    },
                })

                if err then
                    error(err)
                end

                return response.body.data
            end,

            get_url = function()
                return 'https://api.mistral.ai/v1/chat/completions'
            end,
        },

        ollama = {
            disabled = true,
            prepare_input = providers.copilot.prepare_input,
            prepare_output = providers.copilot.prepare_output,

            get_models = function(headers)
                local response, err = cutils.curl_get('http://localhost:11434/v1/models', {
                    headers = headers,
                    json_response = true,
                })

                if err then
                    error(err)
                end

                return vim.tbl_map(function(model)
                    return {
                        id = model.id,
                        name = model.id,
                    }
                end, response.body.data)
            end,

            embed = function(inputs, headers)
                local response, err = cutils.curl_post('http://localhost:11434/v1/embeddings', {
                    headers = headers,
                    json_request = true,
                    json_response = true,
                    body = {
                        input = inputs,
                        model = 'all-minilm',
                    },
                })

                if err then
                    error(err)
                end

                return response.body.data
            end,

            get_url = function()
                return 'http://localhost:11434/v1/chat/completions'
            end,
        },

        lmstudio = {
            disabled = true,
            prepare_input = providers.copilot.prepare_input,
            prepare_output = providers.copilot.prepare_output,

            get_models = function(headers)
                local response, err = cutils.curl_get('http://localhost:1234/v1/models', {
                    headers = headers,
                    json_response = true,
                })

                if err then
                    error(err)
                end

                return vim.tbl_map(function(model)
                    return {
                        id = model.id,
                        name = model.id,
                    }
                end, response.body.data)
            end,

            embed = function(inputs, headers)
                local response, err = cutils.curl_post('http://localhost:1234/v1/embeddings', {
                    headers = headers,
                    json_request = true,
                    json_response = true,
                    body = {
                        dimensions = 512,
                        input = inputs,
                        model = 'text-embedding-nomic-embed-text-v1.5',
                    },
                })

                if err then
                    error(err)
                end

                return response.body.data
            end,

            get_url = function()
                return 'http://localhost:1234/v1/chat/completions'
            end,
        },
    },
})

utils.au('BufEnter', {
    pattern = 'copilot-*',
    callback = function()
        vim.opt_local.relativenumber = false
        vim.opt_local.number = false
    end,
})

vim.keymap.set({ 'n' }, '<leader>aa', chat.toggle, { desc = 'AI Toggle' })
vim.keymap.set({ 'v' }, '<leader>aa', chat.open, { desc = 'AI Open' })
vim.keymap.set({ 'n' }, '<leader>ax', chat.reset, { desc = 'AI Reset' })
vim.keymap.set({ 'n' }, '<leader>as', chat.stop, { desc = 'AI Stop' })
vim.keymap.set({ 'n' }, '<leader>am', chat.select_model, { desc = 'AI Models' })
vim.keymap.set({ 'n' }, '<leader>ag', chat.select_agent, { desc = 'AI Agents' })
vim.keymap.set({ 'n', 'v' }, '<leader>ap', chat.select_prompt, { desc = 'AI Prompts' })
vim.keymap.set({ 'n', 'v' }, '<leader>aq', function()
    vim.ui.input({
        prompt = 'AI Question> ',
    }, function(input)
        if input ~= '' then
            chat.ask(input)
        end
    end)
end, { desc = 'AI Question' })
