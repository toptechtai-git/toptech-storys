#!/usr/bin/env node
// Painel local do agendador de stories.
// Escuta so em 127.0.0.1 — usa o git/gh ja autenticados nesta maquina,
// entao nenhuma credencial precisa chegar ao navegador.

import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir, rm, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(AQUI);
const DIR_STORIES = path.join(REPO, "stories");
const PORTA = 4750;

const EXT_IMG = new Set([".png", ".jpg", ".jpeg"]);
const EXT_VID = new Set([".mp4", ".mov"]);
const RE_PASTA = /^[a-z0-9][a-z0-9-]{0,31}$/;
const RE_ARTE = /^\d{3}\.(png|jpe?g|mp4|mov)$/i;
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/** Barra qualquer nome fora do padrao — impede subir de diretorio. */
function pastaSegura(nome) {
  if (!RE_PASTA.test(nome)) throw new Error("Nome de pasta invalido (use a-z, 0-9 e hifen).");
  return path.join(DIR_STORIES, nome);
}
function arteSegura(pasta, arquivo) {
  if (!RE_ARTE.test(arquivo)) throw new Error("Nome de arquivo invalido.");
  return path.join(pastaSegura(pasta), arquivo);
}

async function git(...args) {
  const { stdout } = await exec("git", ["-C", REPO, ...args], { maxBuffer: 8 << 20 });
  return stdout.trim();
}

async function dimensoes(arq) {
  try {
    const { stdout } = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", arq]);
    const w = /pixelWidth: (\d+)/.exec(stdout)?.[1];
    const h = /pixelHeight: (\d+)/.exec(stdout)?.[1];
    return w && h ? { w: +w, h: +h } : null;
  } catch {
    return null;
  }
}

async function artesDe(pasta) {
  const dir = pastaSegura(pasta);
  const itens = await readdir(dir, { withFileTypes: true });
  const nomes = itens
    .filter((d) => d.isFile() && !d.name.startsWith(".") && d.name !== "_config.json")
    .map((d) => d.name)
    .filter((n) => EXT_IMG.has(path.extname(n).toLowerCase()) || EXT_VID.has(path.extname(n).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));

  return Promise.all(
    nomes.map(async (nome) => {
      const arq = path.join(dir, nome);
      const ext = path.extname(nome).toLowerCase();
      const info = await stat(arq);
      const dim = EXT_IMG.has(ext) ? await dimensoes(arq) : null;
      return {
        nome,
        video: EXT_VID.has(ext),
        mb: +(info.size / 1048576).toFixed(2),
        dim,
        ok: EXT_VID.has(ext) ? info.size < 100 * 1048576 : !!dim && dim.w === 1080 && dim.h === 1920 && info.size < 8 * 1048576,
      };
    }),
  );
}

async function lerEstado() {
  const arq = path.join(REPO, "state.json");
  if (!existsSync(arq)) return {};
  try {
    return JSON.parse(await readFile(arq, "utf8"));
  } catch {
    return {};
  }
}

async function montarEstado() {
  const dirs = (await readdir(DIR_STORIES, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const estado = await lerEstado();

  const pastas = [];
  for (const nome of dirs) {
    let cfg = { horarios: [], loop: true, ativo: true };
    const arqCfg = path.join(DIR_STORIES, nome, "_config.json");
    if (existsSync(arqCfg)) {
      try {
        cfg = { ...cfg, ...JSON.parse(await readFile(arqCfg, "utf8")) };
      } catch {
        cfg.erro = "_config.json invalido";
      }
    }
    const artes = await artesDe(nome);
    const st = estado[nome] || { indice: 0, voltas: 0, publicados: {} };
    pastas.push({ nome, cfg, artes, indice: st.indice || 0, voltas: st.voltas || 0, publicados: st.publicados || {} });
  }

  let pendentes = [];
  let branch = "";
  try {
    pendentes = (await git("status", "--porcelain")).split("\n").filter(Boolean);
    branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  } catch {}

  return { pastas, pendentes, branch, hoje: hojeLocal() };
}

function hojeLocal() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Belem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Renumera a pasta inteira para 001..NNN na ordem recebida. */
async function renumerar(pasta, ordem) {
  const dir = pastaSegura(pasta);
  const atuais = (await artesDe(pasta)).map((a) => a.nome);
  const lista = ordem?.length ? ordem : atuais;
  if (lista.length !== atuais.length || !lista.every((n) => atuais.includes(n))) {
    throw new Error("A ordem enviada nao corresponde aos arquivos da pasta.");
  }
  for (const [i, nome] of lista.entries()) {
    await rename(path.join(dir, nome), path.join(dir, `tmp_${String(i + 1).padStart(3, "0")}${path.extname(nome).toLowerCase()}`));
  }
  const temps = (await readdir(dir)).filter((n) => n.startsWith("tmp_")).sort();
  for (const t of temps) {
    await rename(path.join(dir, t), path.join(dir, t.slice(4)));
  }
}

const rotas = {
  "GET /api/estado": () => montarEstado(),

  "POST /api/pasta": async ({ corpo }) => {
    const dir = pastaSegura(String(corpo.nome || "").trim());
    if (existsSync(dir)) throw new Error("Ja existe uma pasta com esse nome.");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "_config.json"), JSON.stringify({ horarios: ["09:00"], loop: true, ativo: true }, null, 2) + "\n");
    await writeFile(path.join(dir, ".gitkeep"), "");
    return { ok: true };
  },

  "POST /api/config": async ({ corpo }) => {
    const dir = pastaSegura(corpo.pasta);
    const horarios = (corpo.horarios || []).map((h) => String(h).trim()).filter(Boolean);
    for (const h of horarios) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) throw new Error(`Horario invalido: ${h}`);
    }
    const cfg = { horarios: [...new Set(horarios)].sort(), loop: !!corpo.loop, ativo: !!corpo.ativo };
    await writeFile(path.join(dir, "_config.json"), JSON.stringify(cfg, null, 2) + "\n");
    return { ok: true };
  },

  "POST /api/pasta/apagar": async ({ corpo }) => {
    await rm(pastaSegura(corpo.pasta), { recursive: true, force: true });
    return { ok: true };
  },

  "POST /api/arte/apagar": async ({ corpo }) => {
    await rm(arteSegura(corpo.pasta, corpo.arquivo), { force: true });
    await renumerar(corpo.pasta);
    return { ok: true };
  },

  "POST /api/ordem": async ({ corpo }) => {
    await renumerar(corpo.pasta, corpo.ordem);
    return { ok: true };
  },

  "POST /api/publicar": async () => {
    const sujo = await git("status", "--porcelain");
    if (!sujo) return { ok: true, msg: "Nada novo para enviar." };
    await git("add", "-A");
    await git("commit", "-m", "painel: atualiza filas de stories");
    try {
      await git("push", "origin", "HEAD");
    } catch (e) {
      await git("pull", "--rebase", "--autostash");
      await git("push", "origin", "HEAD");
    }
    return { ok: true, msg: "Enviado para o GitHub." };
  },
};

async function receberUpload(req, pasta) {
  const dir = pastaSegura(pasta);
  const ext = path.extname(String(req.headers["x-nome"] || "")).toLowerCase();
  if (!EXT_IMG.has(ext) && !EXT_VID.has(ext)) throw new Error("Formato nao aceito (use png, jpg, mp4 ou mov).");

  const pedacos = [];
  for await (const p of req) pedacos.push(p);
  const dados = Buffer.concat(pedacos);
  if (dados.length > 120 * 1048576) throw new Error("Arquivo grande demais.");

  const proximo = (await artesDe(pasta)).length + 1;
  const nome = `${String(proximo).padStart(3, "0")}${ext}`;
  const destino = path.join(dir, nome);
  await writeFile(destino, dados);

  // Reamostra so quando a arte ja esta em 9:16 — nunca distorce proporcao diferente.
  if (EXT_IMG.has(ext)) {
    const d = await dimensoes(destino);
    if (d && (d.w !== 1080 || d.h !== 1920) && Math.abs(d.w / d.h - 1080 / 1920) < 0.02) {
      await exec("sips", ["-z", "1920", "1080", destino]);
    }
  }
  return { ok: true, nome };
}

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const responder = (codigo, dados, tipo = "application/json") => {
    res.writeHead(codigo, { "content-type": tipo, "cache-control": "no-store" });
    res.end(tipo.startsWith("application/json") ? JSON.stringify(dados) : dados);
  };

  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return responder(200, await readFile(path.join(AQUI, "index.html")), TIPOS[".html"]);
    }

    if (url.pathname === "/midia") {
      const arq = arteSegura(url.searchParams.get("pasta"), url.searchParams.get("arquivo"));
      return responder(200, await readFile(arq), TIPOS[path.extname(arq).toLowerCase()] || "application/octet-stream");
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      return responder(200, await receberUpload(req, url.searchParams.get("pasta")));
    }

    const chave = `${req.method} ${url.pathname}`;
    if (rotas[chave]) {
      let corpo = {};
      if (req.method === "POST") {
        const pedacos = [];
        for await (const p of req) pedacos.push(p);
        const texto = Buffer.concat(pedacos).toString("utf8");
        corpo = texto ? JSON.parse(texto) : {};
      }
      return responder(200, await rotas[chave]({ corpo }));
    }

    responder(404, { erro: "Rota nao encontrada." });
  } catch (e) {
    responder(400, { erro: e.message });
  }
});

servidor.listen(PORTA, "127.0.0.1", () => {
  console.log(`Painel de stories: http://127.0.0.1:${PORTA}`);
});
