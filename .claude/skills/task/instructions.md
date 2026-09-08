# Task Management Skill

You are now in task management mode. Help the user manage their software engineering tasks using the `task` command-line tool.

## Available Commands

Use the Bash tool to execute these commands:

```bash
# List all tasks
task list

# Create a new task
task create "Task name"

# Update task status
task status <slug> <status>
# Valid statuses: pending, in-progress, completed, blocked

# Log work to a task
task log <slug> "Work description"

# Show full task details
task show <slug>
```

## Task Structure

Each task is stored in `~/.tasks/<slug>/` with:
- **metadata.json** - Status, timestamps, working_path, related files/commits, tags
- **plan.md** - Work plan with requirements, implementation steps, considerations
- **log.md** - Chronological work log

## Workflow Integration

### When Creating Tasks

1. Ask the user for the task name if not provided
2. Create the task using `task create "name"`
3. Offer to help fill out the plan.md file with:
   - Clear requirements
   - Implementation steps
   - Technical considerations
   - Success criteria

### When Starting Work

1. List available pending tasks: `task list`
2. Update status to in-progress: `task status <slug> in-progress`
3. Track the working directory in metadata (automatically done)

### During Work

1. Log significant progress: `task log <slug> "description"`
2. Update the plan.md if approach changes
3. Track related files and commits in metadata.json

### When Completing Work

1. Log final changes: `task log <slug> "Final summary"`
2. Update status: `task status <slug> completed`
3. Verify success criteria in plan.md are met

### When Blocked

1. Update status: `task status <slug> blocked`
2. Log the blocker: `task log <slug> "Blocked by: reason"`
3. Consider creating a new task for the blocker

## Best Practices

- **Keep tasks focused**: One clear objective per task
- **Update logs regularly**: Log after each significant change
- **Track related files**: Update metadata.json with files modified
- **Track commits**: Add commit hashes to metadata.json after committing
- **Use meaningful slugs**: Task names should be descriptive

## Status Icons

When listing tasks, you'll see:
- `○` pending
- `◐` in-progress
- `●` completed
- `⊗` blocked

## Example Session

```bash
# Start a new feature
task create "Add user authentication"
task status add-user-authentication in-progress

# Work on it, log progress
task log add-user-authentication "Implemented JWT token generation"
task log add-user-authentication "Added login endpoint"

# Complete the task
task log add-user-authentication "All tests passing, feature complete"
task status add-user-authentication completed
```

## Your Role

When this skill is invoked:

1. **Without arguments** (`/task`):
   - Show current tasks with `task list`
   - Ask what the user wants to do

2. **With "create"** (`/task create`):
   - Help create a new task
   - Assist with filling out the plan

3. **With "start"** (`/task start`):
   - Show pending tasks
   - Ask which to start
   - Update status to in-progress

4. **With "log"** (`/task log`):
   - Ask for task slug and message
   - Log the work

5. **With "complete"** (`/task complete`):
   - Ask for task slug
   - Log final summary
   - Mark as completed

6. **With task slug** (`/task <slug>`):
   - Show full task details with `task show <slug>`

Always use simple, direct commands. Follow the user's workflow preferences from their CLAUDE.md.
