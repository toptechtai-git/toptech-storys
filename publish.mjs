#!/usr/bin/env node
// Publica stories no Instagram da Toptech via Meta Graph API.
// Roda a cada 15 min pelo GitHub Actions; decide sozinho quais pastas devem postar agora.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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
// O cron do GitHub e "melhor esforco": ele descarta execucoes quando esta sobrecarregado,
// e o intervalo real entre runs chega a passar de 1h. A janela larga evita perder o slot.
const TOLERANCIA_MIN = Number(process.env.TOLERANCIA_MIN || 120);

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

/**
 * Artes da pasta, cada uma com um id derivado do CONTEUDO do arquivo.
 * E o id que diz se a arte ja foi publicada — assim renomear, reordenar ou
 * reexportar pela pasta raiz nao faz o sistema perder o lugar.
 */
async function midiasDaPasta(pasta) {
  const dir = path.join(DIR_STORIES, pasta);
  const itens = await readdir(dir, { withFileTypes: true });
  const nomes = itens
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name)
    .filter((n) => {
      const ext = path.extname(n).toLowerCase();
      return IMAGENS.has(ext) || VIDEOS.has(ext);
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));

  return Promise.all(
    nomes.map(async (nome) => ({
      nome,
      id: createHash("sha1").update(await readFile(path.join(dir, nome))).digest("hex").slice(0, 12),
    })),
  );
}

/**
 * Decide qual arte sai neste slot, em ordem de prioridade:
 *   1. agendada — marcada com data + hora exatas, publica uma vez so
 *   2. fixa     — marcada so com hora, revezando entre as marcadas na mesma hora
 *   3. fila     — artes sem marcacao, na ordem, com loop opcional
 * Devolve null quando nao ha nada elegivel (o motivo vai pros avisos).
 */
function escolher(cfg, st, artes, hhmm, dia) {
  const marcas = cfg.artes || {};
  const marca = (a) => marcas[a.nome] || {};
  st.feitas ??= [];
  st.pontuais ??= [];
  st.indicesHora ??= {};
  const jaSaiu = (a) => st.feitas.includes(a.id) || st.pontuais.includes(a.id);

  const agendadas = artes.filter((a) => marca(a).data === dia && marca(a).hora === hhmm && !jaSaiu(a));
  if (agendadas.length) return { arte: agendadas[0], tipo: "agendada" };

  const fixas = artes.filter((a) => !marca(a).data && marca(a).hora === hhmm);
  if (fixas.length) {
    const i = (st.indicesHora[hhmm] || 0) % fixas.length;
    return { arte: fixas[i], tipo: "fixa" };
  }

  const fila = artes.filter((a) => !marca(a).hora && !marca(a).data);
  if (!fila.length) {
    avisos.push(`Nada elegivel as ${hhmm}: todas as artes da pasta estao presas a outro horario.`);
    return null;
  }

  let pendentes = fila.filter((a) => !jaSaiu(a));
  if (!pendentes.length) {
    if (cfg.loop === false) {
      avisos.push(`Todas as artes ja foram publicadas e o loop esta desligado — nada saiu as ${hhmm}.`);
      return null;
    }
    st.feitas = []; // recomeca a volta; artes novas entram naturalmente na proxima
    st.voltas = (st.voltas || 0) + 1;
    pendentes = fila;
    avisos.push(`A fila deu a volta (${st.voltas}x) — voltou a publicar do inicio. Hora de renovar as artes.`);
  }

  return { arte: pendentes[0], tipo: "fila" };
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
    const st = (estado[pasta] ??= { voltas: 0, publicados: {} });
    delete st.indice; // modelo antigo por posicao — agora o controle e por conteudo

    const artes = await midiasDaPasta(pasta);
    const porNome = new Map(artes.map((a) => [a.nome, a]));

    // Arte apagada some do historico — senao o registro cresceria para sempre.
    const existentes = new Set(artes.map((a) => a.id));
    for (const chave of ["feitas", "pontuais"]) {
      if (st[chave]) st[chave] = st[chave].filter((id) => existentes.has(id));
    }

    // Agendamento que passou da data sem sair (workflow parado, arte trocada…)
    for (const [nome, m] of Object.entries(cfg.artes || {})) {
      const a = porNome.get(nome);
      if (m.data && m.data < agora.dia && a && !(st.pontuais || []).includes(a.id)) {
        avisos.push(`"${pasta}/${nome}" estava agendada para ${m.data} ${m.hora || ""} e nao foi publicada.`);
      }
    }

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

      if (artes.length === 0) {
        avisos.push(`Pasta "${pasta}" esta vazia — nada publicado as ${hhmm}.`);
        continue;
      }

      const escolha = escolher(cfg, st, artes, hhmm, agora.dia);
      if (!escolha) continue;
      const { arte, tipo } = escolha;
      const arquivo = arte.nome;
      const ehVideo = VIDEOS.has(path.extname(arquivo).toLowerCase());
      const url = urlPublica(pasta, arquivo);
      log(`[${pasta} ${hhmm}] publicando ${arquivo} (${tipo})${DRY_RUN ? " — DRY RUN" : ""}`);

      if (!DRY_RUN) {
        try {
          const id = await publicar(url, ehVideo);
          log(`  ok — media ${id}`);
        } catch (e) {
          avisos.push(`FALHOU "${pasta}" as ${hhmm} (${arquivo}): ${e.message}`);
          continue; // nao avanca o indice: tenta de novo na proxima janela
        }
      }

      if (tipo === "agendada") (st.pontuais ??= []).push(arte.id);
      else if (tipo === "fixa") st.indicesHora[hhmm] = (st.indicesHora[hhmm] || 0) + 1;
      else (st.feitas ??= []).push(arte.id);
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
