#!/usr/bin/env node
// Publica stories no Instagram da Toptech via Meta Graph API.
// Roda a cada 15 min pelo GitHub Actions; decide sozinho quais pastas devem postar agora.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const DIR_STORIES = path.join(RAIZ, "stories");
const ARQ_ESTADO = path.join(RAIZ, "state.json");

const TOKEN = process.env.IG_TOKEN;
const IG_ID = process.env.IG_USER_ID || "17841458291127780";
const REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"
const BRANCH = process.env.GITHUB_REF_NAME || "main";
const TZ = process.env.TZ_LOCAL || "America/Belem";
const API = "https://graph.facebook.com/v21.0";
const DRY_RUN = process.env.DRY_RUN === "1";
const TOLERANCIA_MIN = 59; // janela pra absorver o atraso do cron do GitHub

const IMAGENS = new Set([".jpg", ".jpeg", ".png"]);
const VIDEOS = new Set([".mp4", ".mov"]);

const avisos = [];
const log = (...a) => console.log(...a);

if (!TOKEN) {
  console.error("Falta IG_TOKEN (Secret do repositorio).");
  process.exit(1);
}

/** Data/hora local em partes, sem depender do TZ do runner. */
function agoraLocal() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    dia: `${p.year}-${p.month}-${p.day}`,
    minutos: Number(p.hour) * 60 + Number(p.minute),
    hhmm: `${p.hour}:${p.minute}`,
  };
}

async function lerJson(arq, padrao) {
  if (!existsSync(arq)) return padrao;
  try {
    return JSON.parse(await readFile(arq, "utf8"));
  } catch (e) {
    avisos.push(`${path.relative(RAIZ, arq)} nao e um JSON valido: ${e.message}`);
    return padrao;
  }
}

// A token vai sempre no header, nunca na URL: URL entra em mensagem
// de erro de rede, e o log do Actions e publico neste repositorio.
const AUTH = { Authorization: `Bearer ${TOKEN}` };

async function graph(caminho, corpo) {
  const r = await fetch(`${API}/${caminho}`, {
    method: "POST",
    headers: AUTH,
    body: new URLSearchParams(corpo),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    throw new Error(j.error?.message || `HTTP ${r.status}`);
  }
  return j;
}

async function esperarContainer(id) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(`${API}/${id}?fields=status_code,status`, { headers: AUTH });
    const j = await r.json();
    if (j.status_code === "FINISHED") return;
    if (j.status_code === "ERROR" || j.status_code === "EXPIRED") {
      throw new Error(`container ${j.status_code}: ${j.status || ""}`);
    }
  }
  throw new Error("container nao ficou pronto em 150s");
}

async function publicar(urlMidia, ehVideo) {
  const campo = ehVideo ? "video_url" : "image_url";
  const criado = await graph(`${IG_ID}/media`, { media_type: "STORIES", [campo]: urlMidia });
  if (ehVideo) await esperarContainer(criado.id);
  else await new Promise((r) => setTimeout(r, 8000));
  const pub = await graph(`${IG_ID}/media_publish`, { creation_id: criado.id });
  return pub.id;
}

function urlPublica(pasta, arquivo) {
  const partes = ["stories", pasta, arquivo].map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${partes}`;
}

async function midiasDaPasta(pasta) {
  const itens = await readdir(path.join(DIR_STORIES, pasta), { withFileTypes: true });
  return itens
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name)
    .filter((n) => {
      const ext = path.extname(n).toLowerCase();
      return IMAGENS.has(ext) || VIDEOS.has(ext);
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
}

async function main() {
  const agora = agoraLocal();
  const estado = await lerJson(ARQ_ESTADO, {});
  const pastas = (await readdir(DIR_STORIES, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let mudou = false;
  log(`Agora ${agora.dia} ${agora.hhmm} (${TZ}) — ${pastas.length} pasta(s)`);

  for (const pasta of pastas) {
    const cfg = await lerJson(path.join(DIR_STORIES, pasta, "_config.json"), null);
    if (!cfg) {
      avisos.push(`Pasta "${pasta}" sem _config.json — ignorada.`);
      continue;
    }
    if (cfg.ativo === false) continue;

    const horarios = Array.isArray(cfg.horarios) ? cfg.horarios : [];
    const st = (estado[pasta] ??= { indice: 0, voltas: 0, publicados: {} });

    for (const hhmm of horarios) {
      const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
      if (!m) {
        avisos.push(`Horario invalido "${hhmm}" em ${pasta}/_config.json (use "HH:MM").`);
        continue;
      }
      const alvo = Number(m[1]) * 60 + Number(m[2]);
      const atraso = agora.minutos - alvo;
      if (atraso < 0 || atraso > TOLERANCIA_MIN) continue;
      if (st.publicados[hhmm] === agora.dia) continue; // ja saiu hoje nesse slot

      const arquivos = await midiasDaPasta(pasta);
      if (arquivos.length === 0) {
        avisos.push(`Pasta "${pasta}" esta vazia — nada publicado as ${hhmm}.`);
        continue;
      }

      if (st.indice >= arquivos.length) {
        if (cfg.loop === false) {
          avisos.push(`Fila de "${pasta}" acabou e loop esta desligado — nada publicado.`);
          continue;
        }
        st.indice = 0;
        st.voltas = (st.voltas || 0) + 1;
        avisos.push(
          `Fila de "${pasta}" deu a volta (${st.voltas}x) — voltou a publicar do inicio. Hora de renovar as artes.`,
        );
      }

      const arquivo = arquivos[st.indice];
      const ehVideo = VIDEOS.has(path.extname(arquivo).toLowerCase());
      const url = urlPublica(pasta, arquivo);
      log(`[${pasta} ${hhmm}] publicando ${arquivo}${DRY_RUN ? " (DRY RUN)" : ""}`);

      if (!DRY_RUN) {
        try {
          const id = await publicar(url, ehVideo);
          log(`  ok — media ${id}`);
        } catch (e) {
          avisos.push(`FALHOU "${pasta}" as ${hhmm} (${arquivo}): ${e.message}`);
          continue; // nao avanca o indice: tenta de novo na proxima janela
        }
      }

      st.indice += 1;
      st.publicados[hhmm] = agora.dia;
      st.ultimo = `${agora.dia} ${agora.hhmm} ${pasta}/${arquivo}`;
      mudou = true;
    }
  }

  // So notifica quando o conjunto de avisos muda — senao viraria uma issue a cada 15 min.
  const assinatura = avisos.join("|");
  const inedito = avisos.length > 0 && estado._ultimosAvisos !== assinatura;
  if (estado._ultimosAvisos !== assinatura) {
    estado._ultimosAvisos = assinatura;
    mudou = true;
  }

  if (mudou) await writeFile(ARQ_ESTADO, JSON.stringify(estado, null, 2) + "\n");

  if (avisos.length) {
    log("\nAvisos:\n" + avisos.map((a) => `- ${a}`).join("\n"));
    if (inedito && process.env.GITHUB_OUTPUT) {
      await writeFile(
        process.env.GITHUB_OUTPUT,
        `avisos<<EOF\n${avisos.map((a) => `- ${a}`).join("\n")}\nEOF\n`,
        { flag: "a" },
      );
    }
  }
}

main().catch((e) => {
  console.error("Erro fatal:", e.message);
  process.exit(1);
});
