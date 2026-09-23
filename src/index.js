import { Bot, InlineKeyboard } from "grammy";
import { createSberClient } from "./llm.js";
import {
  closeRoundMessages,
  contributionMessages,
  questionMessages,
  solutionMessages
} from "./prompts.js";
import { loadState, loadStory, publicUser, resetState, saveState } from "./store.js";

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  sberApiKey: process.env.SBER_API_KEY,
  adminId: String(process.env.ADMIN_TELEGRAM_ID || ""),
  sberBaseUrl: process.env.SBER_BASE_URL,
  sberModel: process.env.SBER_MODEL,
  timeZone: process.env.TIME_ZONE || "Europe/Moscow",
  autoSchedule: String(process.env.AUTO_SCHEDULE).toLowerCase() === "true",
  openHour: Number(process.env.OPEN_HOUR || 10),
  reminderHour: Number(process.env.REMINDER_HOUR || 19),
  closeHour: Number(process.env.CLOSE_HOUR || 20),
  maxQuestions: Number(process.env.MAX_QUESTIONS_PER_ROUND || 2)
};

if (!config.telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is missing");
if (!config.sberApiKey) throw new Error("SBER_API_KEY is missing");
if (!config.sberBaseUrl) throw new Error("SBER_BASE_URL is missing (use the Base URL provided by Sber500)");
if (!config.sberModel) throw new Error("SBER_MODEL is missing (use a model listed by the Sber API)");
if (!config.adminId) throw new Error("ADMIN_TELEGRAM_ID is missing");

const story = await loadStory();
let state = await loadState(story);
const bot = new Bot(config.telegramToken);
const askSber = createSberClient({
  apiKey: config.sberApiKey,
  baseUrl: config.sberBaseUrl,
  model: config.sberModel
});
let roundBusy = false;

function isAdmin(ctx) {
  return String(ctx.from?.id) === config.adminId;
}

function participantName(user) {
  return user.username ? `@${user.username}` : user.firstName;
}

async function registerParticipant(ctx) {
  const user = publicUser(ctx.from);
  const previous = state.participants[user.id];
  state.participants[user.id] = {
    ...previous,
    ...user,
    chatId: String(ctx.chat.id),
    joinedAt: previous?.joinedAt || new Date().toISOString(),
    active: true
  };
  await saveState(state);
  return state.participants[user.id];
}

async function send(chatId, text, options = {}) {
  try {
    await bot.api.sendMessage(chatId, text, options);
    return true;
  } catch (error) {
    console.error(`Could not send to ${chatId}:`, error.message);
    return false;
  }
}

async function broadcast(text, options = {}) {
  const participants = Object.values(state.participants).filter((item) => item.active);
  await Promise.all(participants.map((item) => send(item.chatId, text, options)));
}

function quickKeyboard() {
  const keyboard = new InlineKeyboard();
  state.current.quickOptions.forEach((option, index) => {
    keyboard.text(option, `idea:${index}`).row();
  });
  return keyboard;
}

function roundMessage() {
  const detectiveHint = story.detective?.enabled
    ? "\n\n🔎 Наводящий вопрос: /ask ваш вопрос\n📋 Все улики: /clues"
    : "";
  return `📖 ${story.title}\nРаунд ${state.round}/${story.totalRounds}\n\n${state.current.chapter}\n\n❓ ${state.current.question}\n\nНапишите свою идею обычным сообщением или выберите быстрый вариант.${detectiveHint}`;
}

async function openRound() {
  if (state.status === "finished") throw new Error("История уже завершена. Для нового теста нужен /reset CONFIRM.");
  if (state.status === "open") throw new Error("Раунд уже открыт.");
  state.status = "open";
  await saveState(state);
  await broadcast(roundMessage(), { reply_markup: quickKeyboard() });
}

function addClue(text, source, round = state.round) {
  const clean = String(text || "").trim();
  if (!clean) return;
  const duplicate = state.clues.some((item) => item.text.toLowerCase() === clean.toLowerCase());
  if (duplicate) return;
  state.clues.push({
    id: `${source}-${Date.now()}-${state.clues.length + 1}`,
    text: clean,
    source,
    round
  });
}

async function submitContribution(user, rawText, chatId) {
  if (state.status !== "open") {
    await send(chatId, "Сейчас окно идей закрыто. Дождитесь следующего раунда.");
    return;
  }

  const text = rawText.trim().slice(0, 1500);
  if (!text) return;
  await send(chatId, "⏳ Читаю идею…");

  try {
    const { data } = await askSber(contributionMessages(story, state, text), {
      maxTokens: 2500,
      temperature: 0.6
    });

    if (!data.accepted) {
      await send(chatId, `Идея не принята: ${data.moderationReason || "она не подходит правилам истории"}`);
      return;
    }

    const contribution = {
      id: `${state.round}-${user.id}`,
      round: state.round,
      user,
      originalText: text,
      safeText: String(data.safeText || text),
      cluster: String(data.cluster || "другая версия"),
      shadowBranch: String(data.shadowBranch || "У этой версии может быть неожиданное продолжение."),
      createdAt: new Date().toISOString()
    };
    const existingIndex = state.contributions.findIndex(
      (item) => item.round === state.round && item.user.id === user.id
    );
    if (existingIndex >= 0) state.contributions[existingIndex] = contribution;
    else state.contributions.push(contribution);
    await saveState(state);

    await send(
      chatId,
      `✅ Идея сохранена${existingIndex >= 0 ? " вместо предыдущей" : ""}.\nКластер: ${contribution.cluster}\n\n🌒 Ваша теневая ветка:\n${contribution.shadowBranch}`
    );
  } catch (error) {
    console.error(error);
    await send(chatId, "Не удалось обработать идею. Попробуйте ещё раз чуть позже.");
  }
}

async function answerQuestion(user, rawQuestion, chatId) {
  if (state.status !== "open") {
    await send(chatId, "Вопросы можно задавать только во время открытого раунда.");
    return;
  }
  const previousCount = state.questions.filter(
    (item) => item.round === state.round && item.user.id === user.id && item.isUseful
  ).length;
  if (previousCount >= config.maxQuestions) {
    await send(chatId, `На один раунд доступно ${config.maxQuestions} вопроса. Новое окно откроется в следующем раунде.`);
    return;
  }

  const question = rawQuestion.trim().slice(0, 1000);
  if (!question) {
    await send(chatId, "Формат: /ask Что было записано на диктофоне?");
    return;
  }
  await send(chatId, "🔎 Проверяю по журналу расследования…");

  try {
    const { data } = await askSber(questionMessages(story, state, question), {
      maxTokens: 2500,
      temperature: 0.35
    });
    const item = {
      id: `q-${Date.now()}`,
      round: state.round,
      user,
      question,
      answer: String(data.answer || "Пока недостаточно данных."),
      newCanonFact: !state.sealedSolution && data.newCanonFact ? String(data.newCanonFact) : null,
      isUseful: Boolean(data.isUseful),
      rejectionReason: String(data.rejectionReason || ""),
      createdAt: new Date().toISOString()
    };
    state.questions.push(item);
    if (item.isUseful && item.newCanonFact && !state.sealedSolution) {
      addClue(item.newCanonFact, "question");
    }
    await saveState(state);

    if (!item.isUseful) {
      await send(chatId, item.rejectionReason || item.answer);
      return;
    }

    const newFact = item.newCanonFact ? `\n\n🧩 В журнал добавлена улика:\n${item.newCanonFact}` : "";
    await broadcast(`🔎 ${participantName(user)} спрашивает:\n${question}\n\nВедущий отвечает:\n${item.answer}${newFact}`);
  } catch (error) {
    console.error(error);
    await send(chatId, "Не удалось проверить вопрос. Попробуйте ещё раз чуть позже.");
  }
}

async function sealSolution() {
  if (state.sealedSolution) return;
  const { data } = await askSber(solutionMessages(story, state), {
    maxTokens: 3500,
    temperature: 0.25
  });
  const validNames = story.suspects.map((item) => item.name);
  if (!validNames.includes(data.culprit)) {
    throw new Error(`Solver selected an unknown suspect: ${data.culprit}`);
  }
  if (!Array.isArray(data.evidence) || data.evidence.length < 2 || !data.reveal) {
    throw new Error("Solver returned an incomplete solution");
  }
  state.sealedSolution = {
    ...data,
    lockedAfterRound: state.round,
    lockedAt: new Date().toISOString()
  };
  await saveState(state);
}

function influenceMessage(result, round) {
  const clusters = Array.isArray(result.clusters) && result.clusters.length
    ? result.clusters.map((item) => `• ${item.name} — ${item.count}: ${item.summary}`).join("\n")
    : "• В этом раунде идеи не сложились в отдельные кластеры.";
  const nominations = Array.isArray(result.nominations) && result.nominations.length
    ? `\n\n🏅 Номинации:\n${result.nominations.map((item) => `• ${item.title}: ${item.reason}`).join("\n")}`
    : "";
  return `📊 Итоги раунда ${round}\n\n${clusters}\n\n${result.influenceExplanation}${nominations}`;
}

async function revealFinal() {
  if (!state.sealedSolution) await sealSolution();
  const culprit = state.sealedSolution.culprit.toLowerCase();
  const winners = state.accusations
    .filter((item) => item.round === state.round && item.suspect.toLowerCase().includes(culprit))
    .map((item) => participantName(item.user));
  const winnerText = winners.length
    ? `\n\n🏆 Верно обвинили: ${[...new Set(winners)].join(", ")}`
    : "\n\nНа этот раз никто не назвал преступника точно.";
  await broadcast(`🎭 РАЗГАДКА\n\n${state.sealedSolution.reveal}\n\nКлючевые улики:\n${state.sealedSolution.evidence.map((item) => `• ${item}`).join("\n")}${winnerText}`);
  state.status = "finished";
  await saveState(state);
}

async function closeRound() {
  if (state.status !== "open") throw new Error("Сейчас нет открытого раунда.");
  const round = state.round;
  const contributions = state.contributions.filter((item) => item.round === round);
  const questions = state.questions.filter((item) => item.round === round && item.isUseful);
  const { data: result } = await askSber(
    closeRoundMessages(story, state, contributions, questions),
    { maxTokens: 4000, temperature: 0.75 }
  );
  if (!result.nextChapter || !result.nextQuestion || !Array.isArray(result.quickOptions)) {
    throw new Error("Editor returned an incomplete next chapter");
  }

  state.history.push({
    round,
    chapter: state.current.chapter,
    question: state.current.question,
    result,
    contributionCount: contributions.length,
    questionCount: questions.length,
    closedAt: new Date().toISOString()
  });
  for (const fact of result.newCanonFacts || []) addClue(fact, "chapter", round);
  await broadcast(influenceMessage(result, round));

  if (round >= story.totalRounds) {
    if (!state.sealedSolution) await sealSolution();
    await revealFinal();
    return;
  }

  state.round = round + 1;
  state.current = {
    chapter: String(result.nextChapter),
    question: String(result.nextQuestion),
    quickOptions: Array.isArray(result.quickOptions) ? result.quickOptions.slice(0, 3) : []
  };
  state.status = "closed";
  await saveState(state);

  await broadcast(`📖 Следующая глава готова\n\n${state.current.chapter}\n\nСледующее окно идей пока закрыто.`);

  if (round >= story.detective.solutionLockRound && !state.sealedSolution) {
    await sealSolution();
    await broadcast("🔐 Все факты собраны, разгадка зафиксирована и больше не изменится. В финальном раунде отправьте версию командой /accuse Имя — объяснение.");
  }
}

async function withRoundLock(ctx, action) {
  if (roundBusy) {
    await ctx.reply("Предыдущая операция ещё выполняется.");
    return;
  }
  roundBusy = true;
  try {
    await action();
  } catch (error) {
    console.error(error);
    await ctx.reply(`Не получилось: ${error.message}`);
  } finally {
    roundBusy = false;
  }
}

bot.command("start", async (ctx) => {
  await registerParticipant(ctx);
  await ctx.reply(
    `Вы в тесте «${story.title}». Здесь нет заранее выбранного убийцы: он будет определён только после того, как накопятся улики.\n\nОбычное сообщение — ваша идея продолжения.\n/ask вопрос — проверить деталь\n/clues — журнал улик\n/story — текущая глава\n/accuse имя — финальное обвинение`
  );
  if (state.status === "open") await ctx.reply(roundMessage(), { reply_markup: quickKeyboard() });
});

bot.command("help", async (ctx) => {
  await ctx.reply("/story — глава\n/ask вопрос — спросить ведущего\n/clues — улики\n/accuse имя — обвинить\nОбычный текст — предложить продолжение");
});

bot.command("story", async (ctx) => {
  await registerParticipant(ctx);
  await ctx.reply(roundMessage(), { reply_markup: quickKeyboard() });
});

bot.command("clues", async (ctx) => {
  await registerParticipant(ctx);
  const clues = state.clues.map((item, index) => `${index + 1}. ${item.text}`).join("\n");
  await ctx.reply(`📋 Журнал улик\n\n${clues || "Пока пусто."}`);
});

bot.command("ask", async (ctx) => {
  const participant = await registerParticipant(ctx);
  await answerQuestion(participant, ctx.match || "", ctx.chat.id);
});

bot.command("accuse", async (ctx) => {
  const participant = await registerParticipant(ctx);
  if (!state.sealedSolution) {
    await ctx.reply("Финальное обвинение откроется после фиксации всех фактов.");
    return;
  }
  const text = String(ctx.match || "").trim().slice(0, 1000);
  if (!text) {
    await ctx.reply("Формат: /accuse Вера Лунная — потому что…");
    return;
  }
  const [suspect, ...reasonParts] = text.split(/\s+[—-]\s+/);
  const accusation = {
    round: state.round,
    user: participant,
    suspect: suspect.trim(),
    reason: reasonParts.join(" — ").trim(),
    createdAt: new Date().toISOString()
  };
  const index = state.accusations.findIndex((item) => item.round === state.round && item.user.id === participant.id);
  if (index >= 0) state.accusations[index] = accusation;
  else state.accusations.push(accusation);
  await saveState(state);
  await ctx.reply("🕵️ Обвинение запечатано. До раскрытия никто не увидит вашу версию.");
});

bot.callbackQuery(/^idea:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const participant = await registerParticipant(ctx);
  const option = state.current.quickOptions[Number(ctx.match[1])];
  if (!option) return;
  await submitContribution(participant, option, ctx.chat.id);
});

bot.command("open", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await withRoundLock(ctx, async () => {
    await openRound();
    await ctx.reply(`Раунд ${state.round} открыт.`);
  });
});

bot.command("close", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await withRoundLock(ctx, async () => {
    await ctx.reply("Закрываю раунд и собираю следующую главу…");
    await closeRound();
    await ctx.reply("Готово.");
  });
});

bot.command("finish", async (ctx) => {
  if (!isAdmin(ctx)) return;
  await withRoundLock(ctx, async () => {
    await revealFinal();
    await ctx.reply("Финал опубликован.");
  });
});

bot.command("status", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const contributions = state.contributions.filter((item) => item.round === state.round).length;
  const questions = state.questions.filter((item) => item.round === state.round && item.isUseful).length;
  const accusations = state.accusations.filter((item) => item.round === state.round).length;
  await ctx.reply(`Статус: ${state.status}\nРаунд: ${state.round}/${story.totalRounds}\nУчастников: ${Object.keys(state.participants).length}\nИдей: ${contributions}\nВопросов: ${questions}\nОбвинений: ${accusations}\nРазгадка зафиксирована: ${state.sealedSolution ? "да" : "нет"}`);
});

bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const text = String(ctx.match || "").trim();
  if (!text) return ctx.reply("Формат: /broadcast сообщение");
  await broadcast(`📣 ${text}`);
  await ctx.reply("Отправлено.");
});

bot.command("reset", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (String(ctx.match || "").trim() !== "CONFIRM") {
    await ctx.reply("Это удалит сюжетный прогресс, но сохранит участников. Для подтверждения: /reset CONFIRM");
    return;
  }
  state = await resetState(story, state.participants);
  await ctx.reply("Прогресс сброшен. Можно открыть первый раунд командой /open.");
});

bot.on("message:text", async (ctx) => {
  const participant = await registerParticipant(ctx);
  await submitContribution(participant, ctx.message.text, ctx.chat.id);
});

function localClock() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour) };
}

async function scheduledTick() {
  if (!config.autoSchedule || roundBusy || state.status === "finished") return;
  const { date, hour } = localClock();
  const mark = async (name, action) => {
    const key = `${date}:${name}`;
    if (state.scheduleMarks[key]) return;
    await action();
    state.scheduleMarks[key] = new Date().toISOString();
    await saveState(state);
  };

  roundBusy = true;
  try {
    if (hour === config.openHour && state.status !== "open") {
      await mark("open", openRound);
    }
    if (hour === config.reminderHour && state.status === "open") {
      await mark("reminder", async () => {
        const submitted = new Set(
          state.contributions.filter((item) => item.round === state.round).map((item) => item.user.id)
        );
        const missing = Object.values(state.participants).filter((item) => item.active && !submitted.has(item.id));
        await Promise.all(missing.map((item) => send(item.chatId, `⏰ Раунд ${state.round} скоро закроется. Можно ответить одной кнопкой:`, { reply_markup: quickKeyboard() })));
      });
    }
    if (hour === config.closeHour && state.status === "open") {
      await mark("close", closeRound);
    }
  } catch (error) {
    console.error("Schedule error:", error);
  } finally {
    roundBusy = false;
  }
}

bot.catch((error) => console.error("Telegram update error:", error.error));
setInterval(scheduledTick, 30_000).unref();

console.log(`Story Pulse started: ${story.title}`);
console.log(`Schedule: ${config.autoSchedule ? "automatic" : "manual"}; timezone: ${config.timeZone}`);
await bot.start({ allowed_updates: ["message", "callback_query"] });
