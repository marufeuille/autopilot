import { updateTaskStatus } from '../vault/writer';
import { readTaskFile, TaskFile } from '../vault/reader';

export async function updateTaskStatusActivity(
  filePath: string,
  status: string,
): Promise<void> {
  updateTaskStatus(filePath, status);
}

export async function readTaskActivity(filePath: string): Promise<TaskFile> {
  return readTaskFile(filePath);
}
