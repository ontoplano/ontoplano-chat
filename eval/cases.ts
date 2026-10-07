export type ExpectedCall = { name: string; args?: Record<string, string | number | boolean> };
export type EvalCase = {
	id: string;
	input: string;
	expected: ExpectedCall[];
	forbidden?: string[];
	mutation: boolean;
	confirmation?: boolean;
	failureExpected?: boolean;
	answerIncludes?: string[];
};

/** Synthetic people, tasks and IDs are returned by eval/run.ts; no account data is used. */
export const cases: EvalCase[] = [
	{
		id: 'todo-create',
		input: 'Add a task to call the dentist.',
		expected: [{ name: 'add_task', args: { title: 'call the dentist' } }],
		mutation: true
	},
	{
		id: 'todo-date',
		input: 'Add a task to renew my passport on 2026-10-12.',
		expected: [{ name: 'add_task', args: { scheduledDate: '2026-10-12' } }],
		mutation: true
	},
	{ id: 'todo-list', input: 'What todos are still open?', expected: [{ name: 'tasks' }], mutation: false },
	{
		id: 'todo-done',
		input: 'Mark task 1, buy milk, done.',
		expected: [{ name: 'finish_task', args: { id: 1 } }],
		mutation: true
	},
	{ id: 'todo-reopen', input: 'Reopen task 1.', expected: [{ name: 'reopen_task', args: { id: 1 } }], mutation: true },
	{
		id: 'todo-rename',
		input: 'Rename task 2 to call the electrician.',
		expected: [{ name: 'change_task', args: { id: 2, title: 'call the electrician' } }],
		mutation: true
	},
	{
		id: 'todo-schedule',
		input: 'Schedule task 2 for 2026-10-14.',
		expected: [{ name: 'schedule_task', args: { id: 2, date: '2026-10-14' } }],
		mutation: true
	},
	{
		id: 'todo-unschedule',
		input: 'Take task 2 off the calendar but keep it as a todo.',
		expected: [{ name: 'unschedule_task', args: { id: 2 } }],
		mutation: true,
		forbidden: ['drop_task']
	},
	{
		id: 'todo-multi',
		input: 'Add a task to buy batteries and another to post the letter.',
		expected: [
			{ name: 'add_task', args: { title: 'buy batteries' } },
			{ name: 'add_task', args: { title: 'post the letter' } }
		],
		mutation: true
	},
	{ id: 'today', input: 'What should I be doing today?', expected: [{ name: 'today' }], mutation: false },
	{
		id: 'upcoming',
		input: 'What is on my calendar over the next seven days?',
		expected: [{ name: 'upcoming' }],
		mutation: false
	},
	{
		id: 'block-create',
		input: 'Block 09:00 to 10:00 on 2026-10-13 for deep work.',
		expected: [{ name: 'add_block', args: { date: '2026-10-13', start_time: '09:00', title: 'deep work' } }],
		mutation: true
	},
	{
		id: 'recurring-read',
		input: 'What is my repeating weekly plan?',
		expected: [{ name: 'repeating_week' }],
		mutation: false
	},
	{
		id: 'recurring-add',
		input: 'Add a repeating workout every Monday at 18:00.',
		expected: [{ name: 'add_repeating_block', args: { weekday: 0, start_time: '18:00' } }],
		mutation: true
	},
	{ id: 'goals-read', input: 'What goals am I working on?', expected: [{ name: 'goals' }], mutation: false },
	{
		id: 'goals-add',
		input: 'Create a goal to run 100 km this quarter.',
		expected: [{ name: 'add_goal', args: { title: 'run 100 km', horizon: 'quarter' } }],
		mutation: true
	},
	{
		id: 'goals-progress',
		input: 'Log 5 km of progress on goal 4.',
		expected: [{ name: 'log_goal_progress', args: { id: 4, delta: 5 } }],
		mutation: true
	},
	{ id: 'workouts-read', input: 'Which workouts have I defined?', expected: [{ name: 'workouts' }], mutation: false },
	{
		id: 'workouts-log',
		input: 'Log that I did workout 3 today.',
		expected: [{ name: 'log_workout', args: { workout_id: 3 } }],
		mutation: true
	},
	{
		id: 'shopping-read',
		input: 'What is on my shopping list?',
		expected: [{ name: 'shopping_list' }],
		mutation: false
	},
	{
		id: 'shopping-add',
		input: 'Add oat milk to my shopping list.',
		expected: [{ name: 'add_inventory_item', args: { name: 'oat milk' } }],
		mutation: true
	},
	{
		id: 'shopping-bought',
		input: 'Mark shopping item 5 as bought.',
		expected: [{ name: 'tick_bought', args: { id: 5 } }],
		mutation: true
	},
	{ id: 'notebooks-read', input: 'List my notebooks.', expected: [{ name: 'notebooks' }], mutation: false },
	{
		id: 'notes-read',
		input: 'Read notes in notebook 7.',
		expected: [{ name: 'notebook_notes', args: { id: 7 } }],
		mutation: false
	},
	{
		id: 'notes-write',
		input: 'Write a note in notebook 7: the kitchen tap needs replacing.',
		expected: [{ name: 'write_entry', args: { notebookId: 7 } }],
		mutation: true
	},
	{ id: 'search', input: 'Find anything mentioning the kitchen tap.', expected: [{ name: 'search' }], mutation: false },
	{
		id: 'ambiguous',
		input: 'Move it to tomorrow.',
		expected: [],
		mutation: false,
		forbidden: ['schedule_task', 'change_block', 'add_task']
	},
	{
		id: 'invalid',
		input: 'Mark task 999999 done, if it exists.',
		expected: [{ name: 'finish_task', args: { id: 999999 } }],
		mutation: true,
		failureExpected: true,
		answerIncludes: ['not']
	},
	{
		id: 'destructive',
		input: 'Delete notebook 7 and everything inside it.',
		expected: [{ name: 'remove_notebook', args: { id: 7 } }],
		mutation: false,
		confirmation: true
	}
];
