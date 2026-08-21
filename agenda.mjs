// Regras de agenda compartilhadas pelo robo (publish.mjs) e pelo painel.
// Ficam aqui para o painel prever exatamente o que o robo vai fazer:
// duas implementacoes da mesma regra sempre acabam divergindo.

export const NOMES_DIA = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

export const DIA_POR_EXTENSO = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];

/** As duas categorias. O caminho da pasta e que diz qual e: midias/<categoria>/<pasta>. */
export const CATEGORIAS = ["story", "feed"];

/** "story/campanha" -> { categoria: "story", nome: "campanha" } */
export function partesDaPasta(chave) {
  const barra = String(chave).indexOf("/");
  if (barra < 0) return { categoria: "story", nome: String(chave) };
  return { categoria: chave.slice(0, barra), nome: chave.slice(barra + 1) };
}

export const ehFeed = (chave) => partesDaPasta(chave).categoria === "feed";

/**
 * Feed nao repete nunca: o loop e proibido por categoria, nao por _config.json.
 * Story repete por padrao, e cada pasta pode desligar com loop:false.
 */
export function podeRepetir(chave, cfg) {
  if (ehFeed(chave)) return false;
  return cfg?.loop !== false;
}

/**
 * Dias em que nao se publica. Aceita numero (0 = domingo) ou nome curto
 * ("dom", "seg"…), porque o _config.json tambem e editado na mao.
 */
export function diasDeFolga(valor, avisos = []) {
  const fora = new Set();
  for (const d of Array.isArray(valor) ? valor : []) {
    const n =
      typeof d === "number" ? d : NOMES_DIA.indexOf(String(d).trim().toLowerCase().slice(0, 3));
    if (n >= 0 && n <= 6) fora.add(n);
    else avisos.push(`Dia de folga desconhecido: "${d}" (use 0-6 ou dom/seg/ter/qua/qui/sex/sab).`);
  }
  return fora;
}

/**
 * Por que o dia inteiro esta parado, ou null se e dia normal.
 * `geral` e o conteudo de midias/_geral.json.
 */
export function pausaDoDia(geral, dia, semana, avisos = []) {
  if (geral?.pausarAte && dia <= geral.pausarAte) {
    return `pausa geral até ${dataCurta(geral.pausarAte)}`;
  }
  if (Array.isArray(geral?.pausas) && geral.pausas.includes(dia)) {
    return `pausa marcada para ${dataCurta(dia)}`;
  }
  if (diasDeFolga(geral?.folgas, avisos).has(semana)) {
    return `folga de ${DIA_POR_EXTENSO[semana]}`;
  }
  return null;
}

/** "2026-12-25" -> "25/12". */
export function dataCurta(iso) {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

/** Dia da semana (0 = domingo) de uma data ISO, sem passar pelo fuso do runner. */
export function semanaDe(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/** Soma dias a uma data ISO e devolve ISO. */
export function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Garante os campos que o resto do modulo assume existirem. */
export function normalizarEstado(st) {
  st.feitas ??= [];
  st.pontuais ??= [];
  st.nomesFeitos ??= [];
  st.indicesHora ??= {};
  st.publicados ??= {};
  return st;
}

/**
 * Uma arte conta como publicada se o CONTEUDO ja saiu (id sha1) ou se o NOME
 * do arquivo ja saiu. Guardar os dois e o que impede o acidente de 19/08:
 * reexportar a pasta muda todos os sha1 e zerava a fila inteira.
 */
export function jaPublicada(st, arte) {
  return (
    st.feitas.includes(arte.id) ||
    st.pontuais.includes(arte.id) ||
    st.nomesFeitos.includes(arte.nome)
  );
}

/** Artes que ainda nao sairam, na ordem da pasta. */
export function pendentesDe(st, artes) {
  return artes.filter((a) => !jaPublicada(st, a));
}

/**
 * Decide qual arte sai neste slot, em ordem de prioridade:
 *   1. agendada — marcada com data + hora exatas, publica uma vez so
 *   2. fixa     — marcada so com hora, revezando entre as marcadas na mesma hora
 *   3. fila     — artes sem marcacao, na ordem, com loop opcional
 * Devolve null quando nao ha nada elegivel (o motivo vai pros avisos).
 * Nao publica nada: so escolhe. Quem chama e que grava o estado.
 */
export function escolher(chave, cfg, st, artes, hhmm, dia, avisos = []) {
  const marcas = cfg.artes || {};
  const marca = (a) => marcas[a.nome] || {};
  normalizarEstado(st);
  const feed = ehFeed(chave);

  const agendadas = artes.filter(
    (a) => marca(a).data === dia && marca(a).hora === hhmm && !jaPublicada(st, a),
  );
  if (agendadas.length) return { arte: agendadas[0], tipo: "agendada" };

  // No feed o rodizio por horario republicaria a mesma arte todo dia — nao existe.
  if (!feed) {
    const fixas = artes.filter((a) => !marca(a).data && marca(a).hora === hhmm);
    if (fixas.length) {
      const i = (st.indicesHora[hhmm] || 0) % fixas.length;
      return { arte: fixas[i], tipo: "fixa" };
    }
  }

  const fila = artes.filter((a) => !marca(a).hora && !marca(a).data);
  if (!fila.length) {
    avisos.push(`Nada elegível às ${hhmm} em "${chave}": todas as artes estão presas a outro horário.`);
    return null;
  }

  let pendentes = pendentesDe(st, fila);
  if (!pendentes.length) {
    if (feed) {
      avisos.push(
        `A fila do feed "${chave}" acabou. Post de feed nunca se repete — publique artes novas para voltar a sair.`,
      );
      return null;
    }
    if (!podeRepetir(chave, cfg)) {
      avisos.push(
        `Todas as artes de "${chave}" já foram publicadas e o loop está desligado — nada saiu às ${hhmm}.`,
      );
      return null;
    }
    // Recomeca a volta. Story pode repetir, entao o registro de quem ja saiu zera.
    st.feitas = [];
    st.nomesFeitos = [];
    st.voltas = (st.voltas || 0) + 1;
    pendentes = fila;
    avisos.push(
      `A fila de "${chave}" deu a volta (${st.voltas}x) — voltou a publicar do início. Hora de renovar as artes.`,
    );
  }

  return { arte: pendentes[0], tipo: "fila" };
}

/**
 * Aplica no estado o efeito de ter publicado esta arte — o mesmo passo que o
 * robo da apos publicar. O painel usa numa copia do estado para simular o dia.
 */
export function marcarPublicada(st, arte, tipo, hhmm, dia) {
  normalizarEstado(st);
  if (tipo === "agendada") st.pontuais.push(arte.id);
  else if (tipo === "fixa") st.indicesHora[hhmm] = (st.indicesHora[hhmm] || 0) + 1;
  else st.feitas.push(arte.id);
  // Sempre pelo nome tambem: e o registro que sobrevive a reexportacao da arte.
  if (!st.nomesFeitos.includes(arte.nome)) st.nomesFeitos.push(arte.nome);
  st.publicados[hhmm] = dia;
}

/**
 * Quantos dias de fila ainda restam nesta pasta, considerando as folgas.
 * Devolve null quando a pasta repete (story em loop): nunca acaba.
 */
export function diasDeFilaRestantes(chave, cfg, st, artes, geral) {
  if (podeRepetir(chave, cfg)) return null;
  const porDia = (Array.isArray(cfg.horarios) ? cfg.horarios : []).length;
  if (!porDia) return null;
  const restam = pendentesDe(normalizarEstado(st), artes).length;
  const folga = new Set([...diasDeFolga(cfg.folgas), ...diasDeFolga(geral?.folgas)]);
  const uteis = 7 - folga.size;
  if (uteis <= 0) return Infinity;
  return Math.floor((restam / porDia) * (7 / uteis));
}
