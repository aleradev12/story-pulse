import { readFileSync } from "node:fs";

const templates = JSON.parse(readFileSync(new URL("./prompts.json", import.meta.url), "utf8"));

function render(template, values) {
  return template.replace(/{{(\w+)}}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Missing prompt template value: ${key}`);
    return String(values[key]);
  });
}

function canon(story, state) {
  const published = state.history.map((item) => ({
    round: item.round,
    chapter: item.chapter,
    question: item.question,
    result: item.result
  }));

  return {
    title: story.title,
    genre: story.genre,
    tone: story.tone,
    worldBible: story.worldBible,
    suspects: story.suspects,
    guardrails: story.guardrails,
    currentRound: state.round,
    currentChapter: state.current.chapter,
    currentQuestion: state.current.question,
    published,
    clues: state.clues.map((clue) => clue.text),
    solutionIsLocked: Boolean(state.sealedSolution)
  };
}

const json = (value) => JSON.stringify(value);
const messages = (system, user) => [
  { role: "system", content: system },
  { role: "user", content: user }
];

export function contributionMessages(story, state, text) {
  const prompts = templates.contribution;
  return messages(prompts.system, render(prompts.user, {
    canon: json(canon(story, state)),
    text
  }));
}

export function questionMessages(story, state, question) {
  const prompts = templates.question;
  const lockedRule = state.sealedSolution
    ? "Разгадка уже зафиксирована другим агентом: не добавляй новых фактов, только разъясняй существующие."
    : "Если для полезного ответа необходим новый факт, можешь добавить ровно один небольшой проверяемый факт, совместимый со всем каноном.";
  return messages(render(prompts.system, { lockedRule }), render(prompts.user, {
    canon: json(canon(story, state)),
    question
  }));
}

export function closeRoundMessages(story, state, contributions, questions) {
  const prompts = templates.closeRound;
  return messages(prompts.system, render(prompts.user, {
    canon: json(canon(story, state)),
    contributions: json(contributions.map((item) => ({
      userId: item.user.id,
      text: item.safeText,
      cluster: item.cluster
    }))),
    questions: json(questions.map((item) => ({
      question: item.question,
      answer: item.answer,
      newCanonFact: item.newCanonFact
    })))
  }));
}

export function solutionMessages(story, state) {
  const prompts = templates.solution;
  return messages(prompts.system, render(prompts.user, {
    canon: json(canon(story, state))
  }));
}
