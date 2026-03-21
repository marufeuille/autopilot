import { getDoingStories, getStoryTasks, readStoryFile, StoryFile, TaskFile } from '../vault/reader';
import { updateTaskStatus, updateStoryStatus } from '../vault/writer';

export async function getDoingStoriesActivity(project: string): Promise<StoryFile[]> {
  return getDoingStories(project);
}

export async function getStoryTasksActivity(
  project: string,
  storySlug: string,
): Promise<TaskFile[]> {
  return getStoryTasks(project, storySlug);
}

export async function updateTaskStatusActivity(
  filePath: string,
  status: string,
): Promise<void> {
  updateTaskStatus(filePath, status);
}

export async function updateStoryStatusActivity(
  filePath: string,
  status: string,
): Promise<void> {
  updateStoryStatus(filePath, status);
}

export async function readStoryFileActivity(filePath: string): Promise<StoryFile> {
  return readStoryFile(filePath);
}
