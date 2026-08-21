#!/usr/bin/env node
// Publica stories no Instagram da Toptech via Meta Graph API.
// Roda a cada 15 min pelo GitHub Actions; decide sozinho quais pastas devem postar agora.

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  CATEGORIAS,
  DIA_POR_EXTENSO,
  diasDeFilaRestantes,
  diasDeFolga,
  ehFeed,
  escolher,
  marcarPublicada,
  normalizarEstado,
  pausaDoDia,
  pendentesDe,
} from "./agenda.mjs";

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const DIR_MIDIAS = path.join(RAIZ, "midias");
const ARQ_ESTADO = path.join(RAIZ, "state.json");
const ARQ_NOTIF = path.join(RAIZ, "notificacoes.json");

const NOTIF_PADRAO = {
  modo: "resumo", // "cada" | "resumo" | "nunca"
  horaResumo: "19:00",
  sempreQueFalhar: true,
  avisarFilaFeed: 5, // dias de antecedencia; 0 desliga
  assunto: "{titulo}",
  cabecalho: "",
  rodape: "",
};

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
let notif = { ...NOTIF_PADRAO };

/** Troca {titulo}, {data}, {hora}, {quantidade} e {lista} no texto do usuario. */
function preencher(modelo, campos) {
  return String(modelo || "").replace(/\{(\w+)\}/g, (m, k) => (k in campos ? campos[k] : m));
}

/** Minutos desde a meia-noite de um "HH:MM"; null se o formato nao bate. */
function emMinutos(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
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
    weekday: "short",
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    dia: `${p.year}-${p.month}-${p.day}`,
    minutos: Number(p.hour) * 60 + Number(p.minute),
    hhmm: `${p.hour}:${p.minute}`,
    // 0 = domingo … 6 = sabado, ja no fuso local (nao no do runner)
    semana: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
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

function urlPublica(chave, arquivo) {
  const partes = ["midias", ...chave.split("/"), arquivo].map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${partes}`;
}

/**
 * Artes da pasta, cada uma com um id derivado do CONTEUDO do arquivo.
 * E o id que diz se a arte ja foi publicada — assim renomear, reordenar ou
 * reexportar pela pasta raiz nao faz o sistema perder o lugar.
 */
async function midiasDaPasta(chave) {
  const dir = path.join(DIR_MIDIAS, ...chave.split("/"));
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

const LIMITE_HISTORICO = 80;

/** Guarda o que saiu (e o que falhou) para o painel mostrar o histórico. */
function registrar(estado, item) {
  const h = (estado._historico ??= []);
  h.unshift(item);
  h.length = Math.min(h.length, LIMITE_HISTORICO);
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
function montarRelatorio(agora, lista, resumoDoDia = false) {
  const ok = lista.filter((e) => e.ok);
  const falhas = lista.filter((e) => !e.ok);
  const L = [];
  const data = agora.dia.split("-").reverse().join("/");

  if (notif.cabecalho) L.push(notif.cabecalho.trim() + "\n");
  L.push(
    resumoDoDia
      ? `**Resumo do dia ${data}** (horário de Belém) — fechado às ${agora.hhmm}\n`
      : `**Execução de ${data} às ${agora.hhmm}** (horário de Belém)\n`,
  );

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

  if (!lista.length && !avisos.length) return null;

  L.push("---");
  if (notif.rodape) L.push(notif.rodape.trim() + "\n");
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
  notif = { ...NOTIF_PADRAO, ...(await lerJson(ARQ_NOTIF, {})) };
  // midias/<categoria>/<pasta>. A categoria e o caminho, nao um campo escondido
  // no _config.json: e ela que decide se a arte pode repetir.
  const pastas = [];
  for (const cat of CATEGORIAS) {
    const dir = path.join(DIR_MIDIAS, cat);
    if (!existsSync(dir)) continue;
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.isDirectory()) pastas.push(`${cat}/${d.name}`);
    }
  }
  pastas.sort();

  // Pausa geral: vale para todas as pastas. Cada pasta pode ter as suas folgas.
  const geral = await lerJson(path.join(DIR_MIDIAS, "_geral.json"), {});
  const pausa = pausaDoDia(geral, agora.dia, agora.semana, avisos);

  let mudou = false;
  log(`Agora ${agora.dia} ${agora.hhmm} (${TZ}) — ${pastas.length} pasta(s)`);

  if (pausa) {
    log(`Hoje está parado (${pausa}) — nada será publicado.`);
    return; // sem eventos e sem avisos: nenhuma issue, nenhum e-mail
  }

  for (const pasta of pastas) {
    const cfg = await lerJson(path.join(DIR_MIDIAS, ...pasta.split("/"), "_config.json"), null);
    if (!cfg) {
      avisos.push(`Pasta "${pasta}" sem _config.json — ignorada.`);
      continue;
    }
    const feed = ehFeed(pasta);
    if (feed && cfg.loop) {
      avisos.push(`"${pasta}" tem loop ligado no _config.json — ignorado: post de feed nunca se repete.`);
    }
    if (cfg.ativo === false) continue;
    if (diasDeFolga(cfg.folgas, avisos).has(agora.semana)) {
      log(`[${pasta}] folga de ${DIA_POR_EXTENSO[agora.semana]} — pulada.`);
      continue;
    }

    const horarios = Array.isArray(cfg.horarios) ? cfg.horarios : [];
    const st = normalizarEstado((estado[pasta] ??= { voltas: 0, publicados: {} }));
    delete st.indice; // modelo antigo por posicao
    delete st.tipo;

    const artes = await midiasDaPasta(pasta);
    const porNome = new Map(artes.map((a) => [a.nome, a]));

    // Arte apagada some do registro — senao ele cresceria para sempre.
    // Os ids sao sha1 do conteudo e mudam a cada reexportacao da arte; os nomes
    // nao. Por isso o registro por nome e o que garante que nada se repete.
    const idsVivos = new Set(artes.map((a) => a.id));
    const nomesVivos = new Set(artes.map((a) => a.nome));
    st.feitas = st.feitas.filter((id) => idsVivos.has(id));
    st.pontuais = st.pontuais.filter((id) => idsVivos.has(id));
    st.nomesFeitos = st.nomesFeitos.filter((n) => nomesVivos.has(n));

    // Feed nao repete: avisa antes da fila secar, com a antecedencia configurada.
    const restamDias = diasDeFilaRestantes(pasta, cfg, st, artes, geral);
    if (notif.avisarFilaFeed > 0 && restamDias !== null && restamDias <= notif.avisarFilaFeed) {
      const n = pendentesDe(st, artes).length;
      avisos.push(
        n === 0
          ? `A fila de "${pasta}" acabou — nenhuma arte nova para publicar.`
          : `A fila de "${pasta}" tem ${n} arte(s), cerca de ${restamDias} dia(s). Reponha antes de secar.`,
      );
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

      const escolha = escolher(pasta, cfg, st, artes, hhmm, agora.dia, avisos);
      if (!escolha) continue;
      const { arte, tipo } = escolha;
      const arquivo = arte.nome;
      const ehVideo = VIDEOS.has(path.extname(arquivo).toLowerCase());
      const ehFeed = feed;
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
          registrar(estado, {
            dia: agora.dia,
            hora: agora.hhmm,
            slot: hhmm,
            pasta,
            arquivo,
            tipo,
            feed: ehFeed,
            erro: e.message,
          });
          mudou = true; // o historico registra a falha mesmo sem a arte ter saido
          avisos.push(`FALHOU "${pasta}" as ${hhmm} (${arquivo}): ${e.message}`);
          continue; // nao avanca o indice: tenta de novo na proxima janela
        }
      } else {
        ev.ok = true;
        ev.simulado = true;
      }
      eventos.push(finalizar(ev));

      marcarPublicada(st, arte, tipo, hhmm, agora.dia);
      st.ultimo = `${agora.dia} ${agora.hhmm} ${pasta}/${arquivo}`;
      registrar(estado, {
        dia: agora.dia,
        hora: agora.hhmm,
        slot: hhmm,
        pasta,
        arquivo,
        tipo,
        feed: ehFeed,
      });
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

  // Caderno do dia: o resumo diario e montado com o que se acumulou aqui.
  const diario = (estado._diario ??= { dia: agora.dia, itens: [], enviado: "" });
  if (diario.dia !== agora.dia) {
    diario.dia = agora.dia;
    diario.itens = [];
    diario.enviado = "";
  }
  if (eventos.length && !DRY_RUN) {
    diario.itens.push(...eventos);
    mudou = true;
  }

  const falhas = eventos.filter((e) => !e.ok);
  const ok = eventos.filter((e) => e.ok);
  if (falhas.length) process.exitCode = 1; // job vermelho: falha silenciosa passa despercebida

  // Quem manda o e-mail agora, e com qual conteudo.
  const alvoResumo = emMinutos(notif.horaResumo);
  const fechaODia =
    notif.modo === "resumo" &&
    alvoResumo !== null &&
    agora.minutos >= alvoResumo &&
    diario.enviado !== agora.dia &&
    diario.itens.length > 0;

  let envio = null; // { lista, resumoDoDia }
  if (falhas.length && notif.sempreQueFalhar) envio = { lista: eventos, resumoDoDia: false };
  else if (notif.modo === "cada" && eventos.length) envio = { lista: eventos, resumoDoDia: false };
  else if (fechaODia) envio = { lista: diario.itens, resumoDoDia: true };
  else if (inedito && notif.modo !== "nunca") envio = { lista: [], resumoDoDia: false };

  if (envio?.resumoDoDia) {
    diario.enviado = agora.dia;
    mudou = true;
  }

  // Em simulacao nada foi publicado: gravar o estado marcaria o slot e queimaria a arte.
  if (mudou && !DRY_RUN) await writeFile(ARQ_ESTADO, JSON.stringify(estado, null, 2) + "\n");

  if (avisos.length) log("\nAvisos:\n" + avisos.map((a) => `- ${a}`).join("\n"));
  if (!envio) {
    if (eventos.length) log(`Sem e-mail agora: modo "${notif.modo}" guarda para o resumo das ${notif.horaResumo}.`);
    return;
  }

  const { lista, resumoDoDia } = envio;
  const lok = lista.filter((e) => e.ok);
  const lfalhas = lista.filter((e) => !e.ok);
  const data = agora.dia.split("-").reverse().slice(0, 2).join("/");
  const nomes = (xs) => [...new Set(xs.map((e) => `${e.pasta}/${e.arquivo}`))].join(", ");

  let titulo;
  if (lfalhas.length) {
    titulo = `FALHA ao publicar ${nomes(lfalhas)} — ${data} ${agora.hhmm}`;
  } else if (resumoDoDia) {
    titulo = `Resumo do dia: ${lok.length} publicação(ões) — ${data}`;
  } else if (lok.length) {
    const onde = lok.every((e) => e.ehFeed)
      ? "Post no feed"
      : lok.some((e) => e.ehFeed)
        ? "Publicado"
        : "Story publicado";
    titulo = `${onde}: ${nomes(lok)} — ${data} ${agora.hhmm}`;
  } else {
    titulo = `Avisos do agendador — ${data} ${agora.hhmm}`;
  }

  const assunto = preencher(notif.assunto || "{titulo}", {
    titulo,
    data,
    hora: agora.hhmm,
    quantidade: String(lok.length),
    lista: nomes(lok) || "nada",
  });

  await saida("titulo", assunto);
  await saida("relatorio", montarRelatorio(agora, lista, resumoDoDia) || "");
  await saida("houve_falha", lfalhas.length ? "1" : "0");
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
