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
import { createHash } from "node:crypto";
import {
  CATEGORIAS,
  diasDeFilaRestantes,
  diasDeFolga,
  ehFeed,
  escolher,
  jaPublicada,
  marcarPublicada,
  normalizarEstado,
  partesDaPasta,
  pausaDoDia,
  podeRepetir,
  semanaDe,
  somarDias,
} from "../agenda.mjs";

const exec = promisify(execFile);
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(AQUI);
const DIR_MIDIAS = path.join(REPO, "midias");
const ARQ_NOTIF = path.join(REPO, "notificacoes.json");
const DIR_MINI = path.join(REPO, ".cache-miniaturas");
const PORTA = Number(process.env.PORTA_PAINEL) || 4751;

const NOTIF_PADRAO = {
  modo: "resumo",
  horaResumo: "19:00",
  sempreQueFalhar: true,
  avisarFilaFeed: 5,
  assunto: "{titulo}",
  cabecalho: "",
  rodape: "",
};

const EXT_IMG = new Set([".png", ".jpg", ".jpeg"]);
const EXT_VID = new Set([".mp4", ".mov"]);
const RE_PASTA = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Aceita qualquer nome que o Finder produza — so barra separador de caminho e ocultos.
const RE_ARTE = /^[^/\\]+\.(png|jpe?g|mp4|mov)$/i;
const RE_NUMERADA = /^\d{3}\.(png|jpe?g|mp4|mov)$/i;
const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
};

/**
 * Barra qualquer nome fora do padrao — impede subir de diretorio.
 * A chave e sempre "<categoria>/<pasta>": e a categoria que define story x feed.
 */
function pastaSegura(chave) {
  const { categoria, nome } = partesDaPasta(String(chave || ""));
  if (!CATEGORIAS.includes(categoria)) throw new Error("Categoria invalida (use story ou feed).");
  if (!RE_PASTA.test(nome)) throw new Error("Nome de pasta invalido (use a-z, 0-9 e hifen).");
  return path.join(DIR_MIDIAS, categoria, nome);
}
/** "story/campanha" validado e devolvido como chave — e assim que o state.json indexa. */
function chaveDaPasta(chave) {
  pastaSegura(chave);
  const { categoria, nome } = partesDaPasta(String(chave));
  return `${categoria}/${nome}`;
}

function arteSegura(pasta, arquivo) {
  const nome = String(arquivo || "");
  if (!RE_ARTE.test(nome) || nome.startsWith(".") || nome.includes("..")) {
    throw new Error("Nome de arquivo invalido.");
  }
  return path.join(pastaSegura(pasta), nome);
}

async function git(...args) {
  const { stdout } = await exec("git", ["-C", REPO, ...args], { maxBuffer: 8 << 20 });
  return stdout.trim();
}

/**
 * Miniatura em cache. A grade abre com dezenas de artes e cada PNG de story tem
 * 1080x1920 — servir os originais custava ~28 MB por pasta aberta. A chave inclui
 * tamanho e mtime, entao reexportar a arte invalida a miniatura sozinho.
 */
async function miniatura(arq, info) {
  const chave =
    createHash("sha1").update(`${arq}|${info.size}|${info.mtimeMs}`).digest("hex").slice(0, 16) + ".jpg";
  const destino = path.join(DIR_MINI, chave);
  if (existsSync(destino)) return destino;
  await mkdir(DIR_MINI, { recursive: true });
  await exec("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "440", arq, "--out", destino]);
  return destino;
}

/** Joga fora miniatura de arte que nao existe mais. Roda uma vez, ao subir. */
async function limparMiniaturas() {
  if (!existsSync(DIR_MINI)) return;
  const limite = Date.now() - 30 * 86400000;
  for (const nome of await readdir(DIR_MINI)) {
    const arq = path.join(DIR_MINI, nome);
    const info = await stat(arq).catch(() => null);
    if (info && info.mtimeMs < limite) await rm(arq, { force: true });
  }
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

// Mesmo id que o publish.mjs usa: sha1 do conteudo. Cache por tamanho+mtime
// para nao reler dezenas de megabytes a cada atualizacao da tela.
const cacheId = new Map();
async function idDoConteudo(arq, info) {
  const chave = `${arq}|${info.size}|${info.mtimeMs}`;
  if (cacheId.has(chave)) return cacheId.get(chave);
  const id = createHash("sha1")
    .update(await readFile(arq))
    .digest("hex")
    .slice(0, 12);
  cacheId.set(chave, id);
  return id;
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
        id: await idDoConteudo(arq, info),
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
  const dirs = [];
  for (const cat of CATEGORIAS) {
    const dir = path.join(DIR_MIDIAS, cat);
    if (!existsSync(dir)) continue;
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory()) dirs.push(`${cat}/${d.name}`);
    }
  }
  dirs.sort();
  const estado = await lerEstado();
  const geralCfg = await lerGeral();

  const pastas = [];
  for (const nome of dirs) {
    const feed = ehFeed(nome);
    let cfg = { horarios: [], loop: true, ativo: true, folgas: [] };
    const arqCfg = path.join(pastaSegura(nome), "_config.json");
    if (existsSync(arqCfg)) {
      try {
        cfg = { ...cfg, ...JSON.parse(await readFile(arqCfg, "utf8")) };
      } catch {
        cfg.erro = "_config.json invalido";
      }
    }
    if (feed) cfg.loop = false; // feed nunca repete, venha o que vier no _config.json
    const artes = await artesDe(nome);
    const st = normalizarEstado(estado[nome] || { voltas: 0, publicados: {} });

    for (const a of artes) {
      a.marca = (cfg.artes || {})[a.nome] || null;
      a.jaSaiu = jaPublicada(st, a);
      a.legenda = (cfg.legendas || {})[a.nome] || "";
      // Feed aceita de 4:5 a 1.91:1 — cobrar 9:16 ali daria alarme falso.
      if (feed && a.dim) {
        const razao = a.dim.w / a.dim.h;
        a.ok = razao >= 0.79 && razao <= 1.92 && a.dim.w >= 640 && a.mb < 8;
      }
    }
    // Fila geral = artes sem marcacao; a proxima e a primeira que ainda nao saiu.
    const geral = artes.filter((a) => !a.marca);
    const pendentes = geral.filter((a) => !a.jaSaiu);
    const proxima = (pendentes[0] || geral[0])?.nome ?? null;

    pastas.push({
      nome,
      categoria: partesDaPasta(nome).categoria,
      curto: partesDaPasta(nome).nome,
      feed,
      cfg,
      artes,
      proxima,
      diasDeFila: diasDeFilaRestantes(nome, cfg, st, artes, geralCfg),
      naFila: geral.length,
      restantes: pendentes.length,
      // Nome solto nao quebra mais nada: afeta so a ordem em que as artes saem.
      foraDePadrao: artes.filter((a) => !RE_NUMERADA.test(a.nome)).length,
      jaSaiu: artes.filter((a) => a.jaSaiu).length,
      voltas: st.voltas || 0,
      publicados: st.publicados || {},
    });
  }

  let pendentes = [];
  let branch = "";
  let atras = 0; // commits que o robo ja escreveu e esta copia ainda nao tem
  try {
    pendentes = (await git("status", "--porcelain")).split("\n").filter(Boolean);
    branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    atras = Number(await git("rev-list", "--count", `HEAD..origin/${branch}`)) || 0;
  } catch {}

  const geral = geralCfg;
  const hoje = hojeLocal();
  const agenda = simular(pastas, estado, geral, hoje);

  return {
    pastas,
    pendentes,
    branch,
    atras,
    hoje,
    agora: horaLocal(),
    geral,
    notif: await lerNotif(),
    ...agenda,
    historico: (estado._historico || []).slice(0, 40),
    saude: saude(pastas, geral, agenda.dias[0], (await lerNotif()).avisarFilaFeed || 5),
  };
}

/** Preferencias de e-mail. Ficam num arquivo proprio para o robo ler igual. */
async function lerNotif() {
  if (!existsSync(ARQ_NOTIF)) return { ...NOTIF_PADRAO };
  try {
    return { ...NOTIF_PADRAO, ...JSON.parse(await readFile(ARQ_NOTIF, "utf8")) };
  } catch {
    return { ...NOTIF_PADRAO, erro: "notificacoes.json invalido" };
  }
}

const ARQ_GERAL = path.join(DIR_MIDIAS, "_geral.json");

/** Config que vale para todas as pastas: folgas semanais e pausas por data. */
async function lerGeral() {
  const vazio = { folgas: [], pausas: [], pausarAte: "" };
  if (!existsSync(ARQ_GERAL)) return vazio;
  try {
    return { ...vazio, ...JSON.parse(await readFile(ARQ_GERAL, "utf8")) };
  } catch {
    return { ...vazio, erro: "_geral.json invalido" };
  }
}

/**
 * Roda o mesmo algoritmo do robo sobre uma copia do estado para saber o que sai
 * hoje e nos proximos dias. Copia porque `escolher` avanca a fila ao decidir.
 */
function simular(pastas, estado, geral, hoje, quantosDias = 7) {
  const st = JSON.parse(JSON.stringify(estado));
  const dias = [];

  for (let n = 0; n < quantosDias; n++) {
    const dia = somarDias(hoje, n);
    const semana = semanaDe(dia);
    const pausa = pausaDoDia(geral, dia, semana);
    const slots = [];

    if (!pausa) {
      const daVez = [];
      for (const p of pastas) {
        if (p.cfg.ativo === false || p.cfg.erro) continue;
        if (diasDeFolga(p.cfg.folgas).has(semana)) continue;
        for (const hora of p.cfg.horarios || []) daVez.push({ p, hora });
      }
      // Em ordem de horario: e assim que a fila de cada pasta avanca no dia.
      daVez.sort((a, b) => a.hora.localeCompare(b.hora));

      for (const { p, hora } of daVez) {
        const e = st[p.nome] ?? (st[p.nome] = { voltas: 0, publicados: {} });
        // Slot que ja saiu hoje: o estado real ja avancou a fila, entao mostramos
        // o que o historico registrou em vez de simular por cima.
        if (n === 0 && e.publicados?.[hora] === dia) {
          const reg = (estado._historico || []).find(
            (x) => x.dia === dia && x.slot === hora && x.pasta === p.nome,
          );
          slots.push({
            hora,
            pasta: p.nome,
            arquivo: reg?.arquivo || "—",
            tipo: reg?.tipo || "fila",
            feed: p.feed,
            legenda: reg ? legendaDe(p.cfg, reg.arquivo) : "",
            publicado: true,
            erro: reg?.erro || "",
          });
          continue;
        }

        const escolha = escolher(p.nome, p.cfg, e, p.artes, hora, dia);
        if (!escolha) continue;
        marcarPublicada(e, escolha.arte, escolha.tipo, hora, dia);
        slots.push({
          hora,
          pasta: p.nome,
          arquivo: escolha.arte.nome,
          tipo: escolha.tipo,
          feed: p.feed,
          legenda: legendaDe(p.cfg, escolha.arte.nome),
          publicado: false,
        });
      }
    }
    dias.push({ dia, semana, pausa, slots });
  }

  return { dias };
}

function legendaDe(cfg, arquivo) {
  return cfg.legendas?.[arquivo] ?? cfg.legenda ?? "";
}

/** Problemas que valem um alerta no painel, do mais grave para o menos. */
function saude(pastas, geral, hoje, limiteAviso = 5) {
  const itens = [];
  const add = (nivel, texto) => itens.push({ nivel, texto });

  if (geral.erro) add("erro", "_geral.json está inválido — o robô ignora as pausas até consertar.");

  for (const p of pastas) {
    if (p.cfg.erro) add("erro", `${p.nome}: _config.json inválido, a pasta inteira é ignorada.`);
    if (p.cfg.ativo === false) continue;
    if (!p.artes.length) add("alerta", `${p.nome} está vazia — os horários dela não publicam nada.`);
    else if (!(p.cfg.horarios || []).length) add("alerta", `${p.nome} tem artes mas nenhum horário.`);
    if (p.foraDePadrao) {
      add("aviso", `${p.nome}: ${p.foraDePadrao} arquivo(s) com nome fora do padrão.`);
    }
    const ruins = p.artes.filter((a) => !a.ok).length;
    if (ruins) add("alerta", `${p.nome}: ${ruins} arte(s) fora de 1080×1920 ou grandes demais.`);
    if (p.feed) {
      const semLegenda = p.artes.filter((a) => !legendaDe(p.cfg, a.nome)).length;
      if (semLegenda) add("alerta", `${p.nome}: ${semLegenda} arte(s) de feed sem legenda.`);
    }
    const slots = (p.cfg.horarios || []).length;
    if (slots && p.artes.length) {
      // Feed nao repete: quando a fila seca, ele simplesmente para de publicar.
      if (p.diasDeFila !== null && p.diasDeFila <= limiteAviso) {
        add(
          p.diasDeFila <= 2 ? "erro" : "alerta",
          p.restantes === 0
            ? `${p.nome} está sem arte nova — não publica mais nada até você repor.`
            : `${p.nome} tem ${p.restantes} arte(s), cerca de ${p.diasDeFila} dia(s), e não recomeça.`,
        );
      } else if (p.diasDeFila === null && Math.floor(p.restantes / slots) <= 2) {
        add("aviso", `${p.nome} dá a volta em ${Math.floor(p.restantes / slots)} dia(s) — as artes vão repetir.`);
      }
    }
  }

  if (hoje?.pausa) add("aviso", `Hoje está parado: ${hoje.pausa}.`);
  return itens;
}

function horaLocal() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Belem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

/** Dias 0-6 (0 = domingo), sem repetido e em ordem. */
function diasValidos(lista) {
  const dias = (Array.isArray(lista) ? lista : []).map(Number);
  if (dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error("Dia de folga invalido: use 0 (domingo) a 6 (sabado).");
  }
  return [...new Set(dias)].sort();
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
  const novoNome = new Map();
  for (const [i, nome] of lista.entries()) {
    novoNome.set(nome, `${String(i + 1).padStart(3, "0")}${path.extname(nome).toLowerCase()}`);
    await rename(path.join(dir, nome), path.join(dir, `tmp_${novoNome.get(nome)}`));
  }
  const temps = (await readdir(dir)).filter((n) => n.startsWith("tmp_")).sort();
  for (const t of temps) {
    await rename(path.join(dir, t), path.join(dir, t.slice(4)));
  }

  // O registro de publicadas e por nome de arquivo. Se ele nao acompanhar a
  // renumeracao, a arte 007 que ja saiu vira 006 e o robo publica 007 de novo —
  // no feed isso quebraria a unica garantia que importa ali.
  const arqEstado = path.join(REPO, "state.json");
  const estado = await lerEstado();
  const st = estado[chaveDaPasta(pasta)];
  if (st?.nomesFeitos?.length) {
    st.nomesFeitos = st.nomesFeitos
      .filter((n) => novoNome.has(n))
      .map((n) => novoNome.get(n))
      .sort();
    await writeFile(arqEstado, JSON.stringify(estado, null, 2) + "\n");
  }

  // Marcas de horario e legendas seguem a arte, senao apontariam para o arquivo errado.
  const arqCfg = path.join(dir, "_config.json");
  if (existsSync(arqCfg)) {
    const cfg = JSON.parse(await readFile(arqCfg, "utf8"));
    const seguir = (mapa) =>
      Object.fromEntries(
        Object.entries(mapa)
          .filter(([nome]) => novoNome.has(nome))
          .map(([nome, v]) => [novoNome.get(nome), v]),
      );
    let mudou = false;
    for (const chave of ["artes", "legendas"]) {
      if (!cfg[chave]) continue;
      cfg[chave] = seguir(cfg[chave]);
      if (!Object.keys(cfg[chave]).length) delete cfg[chave];
      mudou = true;
    }
    if (mudou) await writeFile(arqCfg, JSON.stringify(cfg, null, 2) + "\n");
  }
}

const rotas = {
  "GET /api/estado": () => montarEstado(),

  "POST /api/pasta": async ({ corpo }) => {
    const categoria = String(corpo.categoria || "story").trim();
    const chave = `${categoria}/${String(corpo.nome || "").trim()}`;
    const dir = pastaSegura(chave);
    if (existsSync(dir)) throw new Error("Ja existe uma pasta com esse nome nesta categoria.");
    await mkdir(dir, { recursive: true });
    const cfg = { horarios: ["09:00"], ativo: true };
    if (categoria === "story") cfg.loop = true; // feed nunca repete: nem oferece a opcao
    else cfg.legenda = "";
    await writeFile(path.join(dir, "_config.json"), JSON.stringify(cfg, null, 2) + "\n");
    await writeFile(path.join(dir, ".gitkeep"), "");
    return { ok: true, pasta: chave };
  },

  "POST /api/config": async ({ corpo }) => {
    const dir = pastaSegura(corpo.pasta);
    const horarios = (corpo.horarios || []).map((h) => String(h).trim()).filter(Boolean);
    for (const h of horarios) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) throw new Error(`Horario invalido: ${h}`);
    }
    // Preserva o que o painel nao edita (tipo, legendas, artes): sobrescrever o
    // arquivo inteiro apagaria as legendas do feed no primeiro salvamento.
    const arqCfg = path.join(dir, "_config.json");
    let cfg = {};
    if (existsSync(arqCfg)) {
      try {
        cfg = JSON.parse(await readFile(arqCfg, "utf8"));
      } catch {
        // Sobrescrever um arquivo quebrado apagaria legendas que dao pra recuperar.
        throw new Error("_config.json desta pasta esta invalido — conserte o arquivo antes de salvar.");
      }
    }
    cfg.horarios = [...new Set(horarios)].sort();
    if (ehFeed(corpo.pasta)) delete cfg.loop; // feed nunca repete — o campo nao existe
    else cfg.loop = !!corpo.loop;
    delete cfg.tipo; // a categoria e o caminho, nao um campo
    cfg.ativo = !!corpo.ativo;
    cfg.folgas = diasValidos(corpo.folgas);
    await writeFile(arqCfg, JSON.stringify(cfg, null, 2) + "\n");
    return { ok: true };
  },

  // Dias em que nenhuma pasta publica.
  "POST /api/folgas": async ({ corpo }) => {
    const geral = await lerGeral();
    if (geral.erro) throw new Error("_geral.json esta invalido — conserte o arquivo antes de salvar.");
    delete geral.erro;
    geral.folgas = diasValidos(corpo.folgas);
    await writeFile(ARQ_GERAL, JSON.stringify(geral, null, 2) + "\n");
    return { ok: true };
  },

  // Datas soltas sem publicacao (feriado, viagem) e pausa continua ate um dia.
  "POST /api/pausas": async ({ corpo }) => {
    const geral = await lerGeral();
    if (geral.erro) throw new Error("_geral.json esta invalido — conserte o arquivo antes de salvar.");
    delete geral.erro;
    const datas = (corpo.pausas || []).map((d) => String(d).trim()).filter(Boolean);
    for (const d of datas) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`Data invalida: ${d}`);
    }
    const ate = String(corpo.pausarAte || "").trim();
    if (ate && !/^\d{4}-\d{2}-\d{2}$/.test(ate)) throw new Error("Data invalida em 'pausar ate'.");
    geral.pausas = [...new Set(datas)].sort();
    geral.pausarAte = ate;
    await writeFile(ARQ_GERAL, JSON.stringify(geral, null, 2) + "\n");
    return { ok: true };
  },

  // Legenda de uma arte (feed) ou da pasta inteira, quando `arquivo` vem vazio.
  "POST /api/legenda": async ({ corpo }) => {
    const dir = pastaSegura(corpo.pasta);
    const arqCfg = path.join(dir, "_config.json");
    let cfg;
    try {
      cfg = JSON.parse(await readFile(arqCfg, "utf8"));
    } catch {
      throw new Error("_config.json desta pasta esta invalido — conserte o arquivo antes de salvar.");
    }
    const texto = String(corpo.texto || "").trim();
    if (texto.length > 2200) throw new Error("A legenda do Instagram vai ate 2200 caracteres.");

    if (corpo.arquivo) {
      const arquivo = path.basename(arteSegura(corpo.pasta, corpo.arquivo));
      cfg.legendas ??= {};
      if (texto) cfg.legendas[arquivo] = texto;
      else delete cfg.legendas[arquivo];
      if (!Object.keys(cfg.legendas).length) delete cfg.legendas;
    } else if (texto) {
      cfg.legenda = texto;
    } else {
      delete cfg.legenda;
    }
    await writeFile(arqCfg, JSON.stringify(cfg, null, 2) + "\n");
    return { ok: true };
  },

  // Prende (ou solta) uma arte num horario fixo, ou agenda numa data exata.
  "POST /api/arte/marcar": async ({ corpo }) => {
    const dir = pastaSegura(corpo.pasta);
    const arquivo = path.basename(arteSegura(corpo.pasta, corpo.arquivo));
    const arqCfg = path.join(dir, "_config.json");
    const cfg = JSON.parse(await readFile(arqCfg, "utf8"));
    cfg.artes ??= {};

    const hora = corpo.hora ? String(corpo.hora).trim() : "";
    const data = corpo.data ? String(corpo.data).trim() : "";
    if (!hora && !data) {
      delete cfg.artes[arquivo];
    } else {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) throw new Error("Informe a hora no formato HH:MM.");
      if (data && !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error("Data invalida.");
      if (!cfg.horarios.includes(hora)) {
        throw new Error(`A pasta nao publica as ${hora}. Adicione esse horario na pasta antes.`);
      }
      cfg.artes[arquivo] = data ? { data, hora } : { hora };
    }
    if (!Object.keys(cfg.artes).length) delete cfg.artes;
    await writeFile(arqCfg, JSON.stringify(cfg, null, 2) + "\n");
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

  // Volta a fila para o comeco. Preserva "publicados" para nao repetir o story de hoje.
  "POST /api/fila/reiniciar": async ({ corpo }) => {
    const pasta = chaveDaPasta(corpo.pasta);
    const arq = path.join(REPO, "state.json");
    const estado = await lerEstado();
    const st = (estado[pasta] ??= { voltas: 0, publicados: {} });
    delete st.indice;
    st.feitas = [];
    st.nomesFeitos = [];
    st.voltas = 0;
    st.pontuais = [];
    st.indicesHora = {};
    await writeFile(arq, JSON.stringify(estado, null, 2) + "\n");
    return { ok: true };
  },

  "POST /api/notificacoes": async ({ corpo }) => {
    const modos = ["cada", "resumo", "nunca"];
    const n = { ...NOTIF_PADRAO, ...(await lerNotif()) };
    delete n.erro;
    if (corpo.modo !== undefined) {
      if (!modos.includes(corpo.modo)) throw new Error("Modo invalido.");
      n.modo = corpo.modo;
    }
    if (corpo.horaResumo !== undefined) {
      const h = String(corpo.horaResumo).trim();
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h)) throw new Error("Hora do resumo invalida.");
      n.horaResumo = h;
    }
    if (corpo.sempreQueFalhar !== undefined) n.sempreQueFalhar = !!corpo.sempreQueFalhar;
    if (corpo.avisarFilaFeed !== undefined) {
      const d = Number(corpo.avisarFilaFeed);
      if (!Number.isInteger(d) || d < 0 || d > 60) throw new Error("Antecedencia invalida (0 a 60 dias).");
      n.avisarFilaFeed = d;
    }
    for (const campo of ["assunto", "cabecalho", "rodape"]) {
      if (corpo[campo] !== undefined) n[campo] = String(corpo[campo]).slice(0, 4000);
    }
    await writeFile(ARQ_NOTIF, JSON.stringify(n, null, 2) + "\n");
    return { ok: true, notif: n };
  },

  // Puxa o que o robo escreveu no GitHub. So leitura: nada sai daqui.
  "POST /api/sincronizar": async () => {
    await git("fetch", "origin");
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    const atras = Number(await git("rev-list", "--count", `HEAD..origin/${branch}`)) || 0;
    if (!atras) return { ok: true, msg: "", atras: 0 };
    await git("pull", "--rebase", "--autostash");
    return { ok: true, msg: `${atras} atualização(ões) do robô baixadas.`, atras };
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

  // Numera pelo maior existente, nunca pela contagem: reaproveitar um numero ja
  // publicado faria a arte nova nascer marcada como "ja saiu" — fatal no feed,
  // onde o registro de publicadas e por nome e nunca se apaga.
  const atuais = (await artesDe(pasta)).map((a) => Number(a.nome.slice(0, 3))).filter(Number.isFinite);
  const proximo = (atuais.length ? Math.max(...atuais) : 0) + 1;
  const nome = `${String(proximo).padStart(3, "0")}${ext}`;
  const destino = path.join(dir, nome);
  await writeFile(destino, dados);

  // Story e sempre 9:16; feed aceita varias proporcoes, entao nao se mexe nele.
  if (EXT_IMG.has(ext) && !ehFeed(pasta)) {
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
      const ext = path.extname(arq).toLowerCase();
      // ?mini=1 devolve a versao leve; sem ele vai o original, para o preview grande.
      if (url.searchParams.get("mini") && EXT_IMG.has(ext)) {
        try {
          const pequena = await miniatura(arq, await stat(arq));
          return responder(200, await readFile(pequena), "image/jpeg");
        } catch {
          /* sips indisponivel ou arquivo estranho: cai no original */
        }
      }
      return responder(200, await readFile(arq), TIPOS[ext] || "application/octet-stream");
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

limparMiniaturas().catch(() => {});

servidor.listen(PORTA, "127.0.0.1", () => {
  console.log(`Painel de stories: http://127.0.0.1:${PORTA}`);
});
