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
 * `geral` e o conteudo de stories/_geral.json.
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

/**
 * Decide qual arte sai neste slot, em ordem de prioridade:
 *   1. agendada — marcada com data + hora exatas, publica uma vez so
 *   2. fixa     — marcada so com hora, revezando entre as marcadas na mesma hora
 *   3. fila     — artes sem marcacao, na ordem, com loop opcional
 * Devolve null quando nao ha nada elegivel (o motivo vai pros avisos).
 * Nao publica nada: so escolhe. Quem chama e que grava o estado.
 */
export function escolher(cfg, st, artes, hhmm, dia, avisos = []) {
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

/**
 * Aplica no estado o efeito de ter publicado esta arte — o mesmo passo que o
 * robo da apos publicar. O painel usa numa copia do estado para simular o dia.
 */
export function marcarPublicada(st, arte, tipo, hhmm, dia) {
  if (tipo === "agendada") (st.pontuais ??= []).push(arte.id);
  else if (tipo === "fixa") st.indicesHora[hhmm] = (st.indicesHora[hhmm] || 0) + 1;
  else (st.feitas ??= []).push(arte.id);
  st.publicados ??= {};
  st.publicados[hhmm] = dia;
}
