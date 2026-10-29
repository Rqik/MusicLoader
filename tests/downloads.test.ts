import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { advanceDemoQueue } from '../src/features/downloads/services/demo-downloads';
import { useDownloadStore } from '../src/features/downloads/store/useDownloadStore';
import { demoTracks } from '../src/shared/lib/demo-tracks';

const [firstTrack, secondTrack, completedTrack, errorTrack] = demoTracks;

function getTask(id: string) {
  const task = useDownloadStore.getState().tasks.find((item) => item.id === id);
  assert.ok(task, `Expected task ${id} to exist`);
  return task;
}

beforeEach(() => {
  useDownloadStore.setState({ tasks: [], isPaused: false });
});

describe('download store', () => {
  it('adds a pending task and ignores a duplicate track', () => {
    const { addTask } = useDownloadStore.getState();
    addTask(firstTrack);
    addTask({ ...firstTrack, title: 'Duplicate title' });

    assert.deepEqual(useDownloadStore.getState().tasks, [
      { ...firstTrack, progress: 0, status: 'pending', attempts: 0 },
    ]);
  });

  it('removes only the requested task and tolerates an unknown id', () => {
    const { addTask, removeTask, updateProgress } = useDownloadStore.getState();
    addTask(firstTrack);
    addTask(secondTrack);
    updateProgress(secondTrack.id, 28);
    const remainingTask = getTask(secondTrack.id);

    removeTask(firstTrack.id);
    removeTask('missing');

    assert.deepEqual(useDownloadStore.getState().tasks, [remainingTask]);
  });

  it('clamps finite progress to 0–100 without changing another task', () => {
    const { addTask, updateProgress } = useDownloadStore.getState();
    addTask(firstTrack);
    addTask(secondTrack);
    updateProgress(firstTrack.id, -20);
    assert.equal(getTask(firstTrack.id).progress, 0);
    updateProgress(firstTrack.id, 56.5);
    assert.equal(getTask(firstTrack.id).progress, 56.5);
    updateProgress(firstTrack.id, 150);
    assert.equal(getTask(firstTrack.id).progress, 100);
    assert.equal(getTask(secondTrack.id).progress, 0);
  });

  it('ignores nonfinite progress values and updates for an unknown task', () => {
    const { addTask, updateProgress } = useDownloadStore.getState();
    addTask(firstTrack);
    updateProgress(firstTrack.id, 35);
    const before = useDownloadStore.getState().tasks;

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      updateProgress(firstTrack.id, value);
    }
    updateProgress('missing', 100);

    assert.deepEqual(useDownloadStore.getState().tasks, before);
  });

  it('sets completed progress to 100 and resets it when returned to pending', () => {
    const { addTask, updateProgress, updateStatus } = useDownloadStore.getState();
    addTask(firstTrack);
    updateProgress(firstTrack.id, 14);
    updateStatus(firstTrack.id, 'completed');
    assert.equal(getTask(firstTrack.id).progress, 100);
    assert.equal(getTask(firstTrack.id).status, 'completed');

    updateStatus(firstTrack.id, 'pending');
    assert.equal(getTask(firstTrack.id).progress, 0);
    assert.equal(getTask(firstTrack.id).status, 'pending');
  });

  it('clears completed tasks while retaining errors and waiting tasks', () => {
    const { addTask, updateStatus, clearCompleted } = useDownloadStore.getState();
    addTask(firstTrack);
    addTask(completedTrack);
    addTask(errorTrack);
    updateStatus(completedTrack.id, 'completed');
    updateStatus(errorTrack.id, 'error');
    const retained = [getTask(firstTrack.id), getTask(errorTrack.id)];

    clearCompleted();

    assert.deepEqual(useDownloadStore.getState().tasks, retained);
  });

  it('retries errors with zero progress and an incremented attempt count', () => {
    const { addTask, updateProgress, updateStatus, retryTask } = useDownloadStore.getState();
    addTask(errorTrack);
    updateProgress(errorTrack.id, 42);
    updateStatus(errorTrack.id, 'error');
    retryTask(errorTrack.id);

    assert.deepEqual(getTask(errorTrack.id), {
      ...errorTrack, progress: 0, status: 'pending', attempts: 1,
    });

    updateStatus(errorTrack.id, 'error');
    retryTask(errorTrack.id);
    assert.equal(getTask(errorTrack.id).attempts, 2);
  });

  it('does not retry pending, downloading, completed or unknown tasks', () => {
    const { addTask, updateProgress, updateStatus, retryTask } = useDownloadStore.getState();
    addTask(firstTrack);

    for (const status of ['pending', 'downloading', 'completed'] as const) {
      updateStatus(firstTrack.id, status);
      if (status === 'downloading') updateProgress(firstTrack.id, 28);
      const before = getTask(firstTrack.id);
      retryTask(firstTrack.id);
      retryTask('missing');
      assert.deepEqual(getTask(firstTrack.id), before);
    }
  });
});

describe('demo queue', () => {
  it('starts the first waiting task and advances only one active task', () => {
    const { addTask } = useDownloadStore.getState();
    addTask(firstTrack);
    addTask(secondTrack);

    advanceDemoQueue();
    advanceDemoQueue();

    assert.equal(getTask(firstTrack.id).status, 'downloading');
    assert.equal(getTask(firstTrack.id).progress, 14);
    assert.equal(getTask(secondTrack.id).status, 'pending');
    assert.equal(getTask(secondTrack.id).progress, 0);
    assert.equal(useDownloadStore.getState().tasks.filter((task) => task.status === 'downloading').length, 1);
  });

  it('neither starts nor advances tasks while paused, and can resume', () => {
    const { addTask, togglePaused } = useDownloadStore.getState();
    addTask(firstTrack);
    togglePaused();
    const waiting = useDownloadStore.getState().tasks;
    advanceDemoQueue();
    assert.deepEqual(useDownloadStore.getState().tasks, waiting);

    togglePaused();
    advanceDemoQueue();
    advanceDemoQueue();
    togglePaused();
    const active = useDownloadStore.getState().tasks;
    advanceDemoQueue();
    assert.deepEqual(useDownloadStore.getState().tasks, active);

    togglePaused();
    advanceDemoQueue();
    assert.equal(getTask(firstTrack.id).progress, 28);
  });

  it('completes the active task and starts the next on the following tick', () => {
    const { addTask, updateProgress } = useDownloadStore.getState();
    addTask(firstTrack);
    addTask(secondTrack);
    advanceDemoQueue();
    updateProgress(firstTrack.id, 98);

    advanceDemoQueue();
    assert.equal(getTask(firstTrack.id).status, 'completed');
    assert.equal(getTask(firstTrack.id).progress, 100);
    assert.equal(getTask(secondTrack.id).status, 'pending');

    advanceDemoQueue();
    assert.equal(getTask(secondTrack.id).status, 'downloading');
    assert.equal(getTask(secondTrack.id).progress, 0);
  });

  it('fails own-wave at 42% on its first attempt and completes after retry', () => {
    const { addTask, retryTask } = useDownloadStore.getState();
    addTask(errorTrack);
    advanceDemoQueue();
    for (let tick = 0; tick < 3; tick += 1) advanceDemoQueue();

    assert.equal(getTask(errorTrack.id).id, 'own-wave');
    assert.equal(getTask(errorTrack.id).status, 'error');
    assert.equal(getTask(errorTrack.id).progress, 42);

    retryTask(errorTrack.id);
    advanceDemoQueue();
    for (let tick = 0; tick < 8; tick += 1) advanceDemoQueue();

    assert.equal(getTask(errorTrack.id).status, 'completed');
    assert.equal(getTask(errorTrack.id).progress, 100);
    assert.equal(getTask(errorTrack.id).attempts, 1);
  });

  it('continues past an error and leaves an empty queue unchanged', () => {
    advanceDemoQueue();
    assert.deepEqual(useDownloadStore.getState().tasks, []);

    const { addTask, updateStatus } = useDownloadStore.getState();
    addTask(errorTrack);
    addTask(secondTrack);
    updateStatus(errorTrack.id, 'error');
    advanceDemoQueue();

    assert.equal(getTask(errorTrack.id).status, 'error');
    assert.equal(getTask(secondTrack.id).status, 'downloading');
  });
});
