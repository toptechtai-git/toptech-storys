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
const eventos = []; // cada tentativa de publicacao, pro relatorio por e-mail
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

/** Relogio local com segundos, pro relatorio ("enviado as 13:37:22"). */
function horaLocal() {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
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
    const err = new Error(j.error?.message || `HTTP ${r.status}`);
    err.code = j.error?.code;
    err.subcode = j.error?.error_subcode;
    throw err;
  }
  return j;
}

/** Traduz o erro da Meta para uma instrucao pratica no e-mail. */
function explicarErro(e) {
  const msg = String(e.message || "");
  if (e.code === 190 || /expired|session|access token/i.test(msg)) {
    return "O token de acesso do Instagram expirou ou foi invalidado. Gere um novo token de Usuário de Sistema no Business Manager e atualize o Secret IG_TOKEN do repositório.";
  }
  if (e.code === 4 || e.code === 17 || /limit/i.test(msg)) {
    return "A Meta bloqueou por limite de publicações (são 25 stories por dia por conta). O próximo horário deve voltar ao normal.";
  }
  if (/media|url|download|fetch/i.test(msg)) {
    return "A Meta não conseguiu baixar a arte pela URL do GitHub. Confira se o arquivo está commitado, se o repositório continua público e se o Git LFS não foi ativado.";
  }
  if (/container/i.test(msg)) {
    return "O vídeo foi enviado mas a Meta não terminou de processar a tempo. Normalmente é arquivo pesado ou codec fora do padrão (use MP4 H.264).";
  }
  return "Erro não catalogado — veja a mensagem original acima e o log da execução.";
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

async function publicar(urlMidia, ehVideo, ehFeed, legenda) {
  const campo = ehVideo ? "video_url" : "image_url";
  const corpo = { [campo]: urlMidia };
  // Story e Reels precisam declarar o tipo; foto de feed e o padrao da API.
  if (!ehFeed) corpo.media_type = "STORIES";
  else if (ehVideo) corpo.media_type = "REELS";
  if (ehFeed && legenda) corpo.caption = legenda;

  const criado = await graph(`${IG_ID}/media`, corpo);
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
      id: createHash("sha1")
        .update(await readFile(path.join(dir, nome)))
        .digest("hex")
        .slice(0, 12),
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

  const agendadas = artes.filter(
    (a) => marca(a).data === dia && marca(a).hora === hhmm && !jaSaiu(a),
  );
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
      avisos.push(
        `Todas as artes ja foram publicadas e o loop esta desligado — nada saiu as ${hhmm}.`,
      );
      return null;
    }
    st.feitas = []; // recomeca a volta; artes novas entram naturalmente na proxima
    st.voltas = (st.voltas || 0) + 1;
    pendentes = fila;
    avisos.push(
      `A fila deu a volta (${st.voltas}x) — voltou a publicar do inicio. Hora de renovar as artes.`,
    );
  }

  return { arte: pendentes[0], tipo: "fila" };
}

function finalizar(ev) {
  ev.fim = horaLocal();
  ev.segundos = Math.round((Date.now() - ev.t0) / 1000);
  delete ev.t0;
  return ev;
}

const ORIGEM = {
  agendada: "agendamento com data e hora marcadas",
  fixa: "arte presa a este horário (rodízio)",
  fila: "fila automática, na ordem da pasta",
};

/** Corpo da issue — e portanto do e-mail que o Filipe recebe. Tudo em português. */
function montarRelatorio(agora) {
  const ok = eventos.filter((e) => e.ok);
  const falhas = eventos.filter((e) => !e.ok);
  const L = [];

  L.push(`**Execução de ${agora.dia.split("-").reverse().join("/")} às ${agora.hhmm}** (horário de Belém)\n`);

  if (ok.length) {
    L.push(`## Publicado com sucesso (${ok.length})\n`);
    for (const e of ok) {
      L.push(`### ${e.pasta}/${e.arquivo}${e.simulado ? " — SIMULAÇÃO, nada foi publicado" : ""}`);
      L.push(
        `- O envio ${e.ehVideo ? "do vídeo" : "da foto"} **${e.arquivo}** foi concluído às **${e.fim}**.`,
      );
      L.push(`- Começou às ${e.inicio} e levou ${e.segundos} segundos.`);
      L.push(`- Horário programado: ${e.hhmm}${e.atraso > 0 ? ` (saiu ${e.atraso} min depois, dentro da tolerância)` : ""}.`);
      L.push(`- Destino: **${e.ehFeed ? "feed" : "story"}**.`);
      L.push(`- Pasta: \`${e.pasta}\` — escolhida por ${ORIGEM[e.tipo] || e.tipo}.`);
      if (e.mediaId) L.push(`- ID da mídia no Instagram: \`${e.mediaId}\`.`);
      L.push(`- Arquivo enviado: ${e.url}`);
      L.push("");
    }
  }

  if (falhas.length) {
    L.push(`## Não foi publicado (${falhas.length})\n`);
    for (const e of falhas) {
      L.push(`### ${e.pasta}/${e.arquivo}`);
      L.push(
        `- A tentativa de enviar ${e.ehVideo ? "o vídeo" : "a foto"} **${e.arquivo}** começou às ${e.inicio} e falhou às **${e.fim}** (${e.segundos} s).`,
      );
      L.push(`- Horário programado: ${e.hhmm} — pasta \`${e.pasta}\`.`);
      L.push(`- Mensagem da Meta: \`${e.erro}\``);
      L.push(`- O que fazer: ${e.dica}`);
      L.push(
        `- A arte **não foi queimada**: ela continua na fila e o sistema tenta de novo na próxima janela (até ${TOLERANCIA_MIN} min depois do horário).`,
      );
      L.push("");
    }
  }

  if (avisos.length) {
    L.push("## Avisos\n");
    for (const a of avisos) L.push(`- ${a}`);
    L.push("");
  }

  if (!eventos.length && !avisos.length) return null;

  L.push("---");
  L.push(`Execução automática: ${urlDoRun() || "rodou fora do GitHub Actions"}`);
  return L.join("\n");
}

function urlDoRun() {
  if (!process.env.GITHUB_RUN_ID) return "";
  const srv = process.env.GITHUB_SERVER_URL || "https://github.com";
  return `${srv}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

async function saida(chave, valor) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delim = `EOF_${Math.random().toString(36).slice(2)}`;
  await writeFile(process.env.GITHUB_OUTPUT, `${chave}<<${delim}\n${valor}\n${delim}\n`, {
    flag: "a",
  });
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
        avisos.push(
          `"${pasta}/${nome}" estava agendada para ${m.data} ${m.hora || ""} e nao foi publicada.`,
        );
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
      const ehFeed = cfg.tipo === "feed";
      const legenda = cfg.legendas?.[arquivo] ?? cfg.legenda ?? "";
      if (ehFeed && !legenda) {
        avisos.push(`"${pasta}/${arquivo}" vai pro feed sem legenda — nenhuma marcada em _config.json.`);
      }
      const url = urlPublica(pasta, arquivo);
      log(`[${pasta} ${hhmm}] publicando ${arquivo} (${tipo})${DRY_RUN ? " — DRY RUN" : ""}`);

      const ev = {
        pasta,
        arquivo,
        hhmm,
        tipo,
        url,
        ehVideo,
        ehFeed,
        atraso,
        inicio: horaLocal(),
        t0: Date.now(),
      };

      if (!DRY_RUN) {
        try {
          ev.mediaId = await publicar(url, ehVideo, ehFeed, legenda);
          ev.ok = true;
          log(`  ok — media ${ev.mediaId}`);
        } catch (e) {
          ev.ok = false;
          ev.erro = e.message;
          ev.dica = explicarErro(e);
          eventos.push(finalizar(ev));
          avisos.push(`FALHOU "${pasta}" as ${hhmm} (${arquivo}): ${e.message}`);
          continue; // nao avanca o indice: tenta de novo na proxima janela
        }
      } else {
        ev.ok = true;
        ev.simulado = true;
      }
      eventos.push(finalizar(ev));

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

  // Em simulacao nada foi publicado: gravar o estado marcaria o slot e queimaria a arte.
  if (mudou && !DRY_RUN) await writeFile(ARQ_ESTADO, JSON.stringify(estado, null, 2) + "\n");

  if (avisos.length) log("\nAvisos:\n" + avisos.map((a) => `- ${a}`).join("\n"));

  // Notifica sempre que algo foi publicado ou falhou. Aviso sem publicacao so
  // notifica quando e inedito — senao viraria um e-mail a cada 15 minutos.
  if (!eventos.length && !inedito) return;

  const falhas = eventos.filter((e) => !e.ok);
  const ok = eventos.filter((e) => e.ok);
  const data = agora.dia.split("-").reverse().slice(0, 2).join("/");
  let titulo;
  if (falhas.length) {
    const q = [...new Set(falhas.map((e) => `${e.pasta}/${e.arquivo}`))].join(", ");
    titulo = `FALHA ao publicar ${q} — ${data} ${agora.hhmm}`;
    process.exitCode = 1; // deixa o job vermelho: falha silenciosa passa despercebida
  } else if (ok.length) {
    const q = ok.map((e) => `${e.pasta}/${e.arquivo}`).join(", ");
    const onde = ok.every((e) => e.ehFeed)
      ? "Post no feed"
      : ok.some((e) => e.ehFeed)
        ? "Publicado"
        : "Story publicado";
    titulo = `${onde}: ${q} — ${data} ${agora.hhmm}`;
  } else {
    titulo = `Avisos do agendador — ${data} ${agora.hhmm}`;
  }

  await saida("titulo", titulo);
  await saida("relatorio", montarRelatorio(agora) || "");
  await saida("houve_falha", falhas.length ? "1" : "0");
}

main()
  .catch(async (e) => {
    console.error("Erro fatal:", e.message);
    const agora = agoraLocal();
    const data = agora.dia.split("-").reverse().slice(0, 2).join("/");
    await saida("titulo", `FALHA GERAL do agendador — ${data} ${agora.hhmm}`);
    await saida(
      "relatorio",
      [
        `**O agendador de stories parou com erro às ${horaLocal()}** (horário de Belém), em ${data}.`,
        "",
        `- Mensagem: \`${e.message}\``,
        "- Nenhuma arte foi marcada como publicada; a fila continua intacta.",
        "- O sistema tenta de novo na próxima execução (a cada 15 minutos).",
        "",
        "---",
        `Log completo: ${urlDoRun() || "execução local"}`,
      ].join("\n"),
    );
    await saida("houve_falha", "1");
    process.exit(1);
  })
  .catch(() => process.exit(1));
