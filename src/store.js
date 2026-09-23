import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(sourceDir, "..");
const dataDir = path.join(projectDir, "data");
const storyPath = path.join(projectDir, "story.json");
const statePath = path.join(dataDir, "state.json");
const tempStatePath = path.join(dataDir, "state.json.tmp");

export async function loadStory() {
  return JSON.parse(await readFile(storyPath, "utf8"));
}

function createInitialState(story) {
  return {
    version: 1,
    storyId: story.id,
    status: "idle",
    round: 1,
    participants: {},
    current: {
      chapter: story.initialChapter,
      question: story.initialQuestion,
      quickOptions: story.initialQuickOptions
    },
    contributions: [],
    questions: [],
    accusations: [],
    clues: story.initialClues.map((text, index) => ({
      id: `initial-${index + 1}`,
      text,
      source: "initial",
      round: 1
    })),
    history: [],
    sealedSolution: null,
    scheduleMarks: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export async function loadState(story) {
  await mkdir(dataDir, { recursive: true });
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.storyId !== story.id) {
      throw new Error(`State belongs to story '${state.storyId}', expected '${story.id}'`);
    }
    return state;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = createInitialState(story);
    await saveState(state);
    return state;
  }
}

export async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await mkdir(dataDir, { recursive: true });
  await writeFile(tempStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempStatePath, statePath);
}

export async function resetState(story, participants = {}) {
  const state = createInitialState(story);
  state.participants = participants;
  await saveState(state);
  return state;
}

export function publicUser(from) {
  return {
    id: String(from.id),
    username: from.username || null,
    firstName: from.first_name || "Участник",
    lastName: from.last_name || null
  };
}
