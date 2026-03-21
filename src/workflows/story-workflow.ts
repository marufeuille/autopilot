import { proxyActivities, executeChild } from '@temporalio/workflow';
import type { TaskFile, StoryFile } from '../vault/reader';
import { taskWorkflow } from './task-workflow';

const {
  getStoryTasksActivity,
  updateStoryStatusActivity,
  sendStoryDoneNotification,
} = proxyActivities<{
  getStoryTasksActivity(project: string, storySlug: string): Promise<TaskFile[]>;
  updateStoryStatusActivity(filePath: string, status: string): Promise<void>;
  sendStoryDoneNotification(storySlug: string, project: string): Promise<void>;
}>({
  startToCloseTimeout: '5 minutes',
});

export interface StoryWorkflowParams {
  story: StoryFile;
  project: string;
}

export async function storyWorkflow(params: StoryWorkflowParams): Promise<void> {
  const { story, project } = params;

  const tasks = await getStoryTasksActivity(project, story.slug);
  const todoTasks = tasks.filter((t) => t.status === 'Todo');

  // タスクを順番に実行（並列ではなく直列）
  for (const task of todoTasks) {
    await executeChild(taskWorkflow, {
      workflowId: `${story.slug}--${task.slug}--${Date.now()}`,
      args: [{ task, project, storySlug: story.slug }],
    });
  }

  // 全タスク完了
  await updateStoryStatusActivity(story.filePath, 'Done');
  await sendStoryDoneNotification(story.slug, project);
}
