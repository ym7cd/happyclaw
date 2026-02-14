// Task management routes

import { Hono } from 'hono';
import * as crypto from 'node:crypto';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { TaskCreateSchema, TaskPatchSchema } from '../schemas.js';
import {
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getTaskRunLogs,
  getRegisteredGroup,
  getAllRegisteredGroups,
} from '../db.js';
import type { AuthUser, ScheduledTask, RegisteredGroup } from '../types.js';
import { isHostExecutionGroup, hasHostExecutionPermission } from '../web-context.js';

const tasksRoutes = new Hono<{ Variables: Variables }>();

// --- Utility Functions ---

function resolveGroupForTask(task: Pick<ScheduledTask, 'chat_jid' | 'group_folder'>): RegisteredGroup | undefined {
  const direct = getRegisteredGroup(task.chat_jid);
  if (direct && direct.folder === task.group_folder) return direct;
  const allGroups = getAllRegisteredGroups();
  return Object.values(allGroups).find(
    (group) => group.folder === task.group_folder,
  ) as RegisteredGroup | undefined;
}

// --- Routes ---

tasksRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const tasks = getAllTasks().filter((task) => {
    const group = resolveGroupForTask(task);
    // Conservative: if group can't be resolved, only admin can see (may be orphaned host task)
    if (!group) return hasHostExecutionPermission(authUser);
    if (!isHostExecutionGroup(group)) return true;
    return hasHostExecutionPermission(authUser);
  });
  return c.json({ tasks });
});

tasksRoutes.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const validation = TaskCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const {
    group_folder,
    chat_jid,
    prompt,
    schedule_type,
    schedule_value,
    context_mode,
  } = validation.data;
  const group = getRegisteredGroup(chat_jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (group.folder !== group_folder) {
    return c.json(
      { error: 'group_folder does not match chat_jid group folder' },
      400,
    );
  }
  const authUser = c.get('user') as AuthUser;
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  createTask({
    id: taskId,
    group_folder,
    chat_jid,
    prompt,
    schedule_type,
    schedule_value,
    context_mode: context_mode || 'isolated',
    next_run: now,
    status: 'active',
    created_at: now,
  });

  return c.json({ success: true, taskId });
});

tasksRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group = resolveGroupForTask(existing);
  // Conservative: unresolvable group tasks require admin (may be orphaned host tasks)
  if ((!group || isHostExecutionGroup(group)) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  const body = await c.req.json().catch(() => ({}));

  const validation = TaskPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  updateTask(id, validation.data);

  return c.json({ success: true });
});

tasksRoutes.delete('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group = resolveGroupForTask(existing);
  if ((!group || isHostExecutionGroup(group)) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  deleteTask(id);
  return c.json({ success: true });
});

tasksRoutes.get('/:id/logs', authMiddleware, (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group = resolveGroupForTask(existing);
  if ((!group || isHostExecutionGroup(group)) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const logs = getTaskRunLogs(id, limit);
  return c.json({ logs });
});

export default tasksRoutes;
