# Stories Toptech — agendador automático

Publica no @toptech_pa em horários fixos, todo dia, sem abrir o Business Suite.

Abra o painel com **Abrir painel.command** (duplo clique). Ele é a forma normal de
mexer em tudo que está documentado aqui; os arquivos abaixo existem para você
entender o que o painel escreve.

## Duas categorias, e a diferença importa

```
midias/
  story/          repete: quando a fila acaba, volta ao primeiro
    manha/          08:50
    produtos/       09:30 11:00 11:30 12:00 12:30
    campanha/       10:15 16:30
  feed/           NUNCA repete: quando a fila acaba, para de publicar
    campanha/       08:45
```

A categoria é o **caminho da pasta**, não um campo de configuração. `midias/story/x`
sai como story de 24h; `midias/feed/x` sai como post no feed, com legenda.

**Feed não se repete em nenhuma hipótese.** Um post repetido no feed fica visível
para sempre no perfil; um story some em 24h. Por isso o robô guarda, por nome de
arquivo e para sempre, tudo que já foi ao feed — e `loop` nem existe nessas pastas.
Quando a fila do feed está acabando, você recebe um e-mail avisando com a
antecedência configurada no painel.

## Como uma arte é escolhida

Ordem de prioridade em cada horário:

1. **agendada** — arte marcada com data + hora exatas. Sai uma vez só.
2. **fixa** — arte marcada só com hora. Reveza entre as marcadas naquela hora. Só em story.
3. **fila** — o resto, na ordem alfabética do nome do arquivo (`001`, `002`, `003`…).

Cada horário consome **um** arquivo. A ordem se muda no painel, com as setas.

### Como o robô sabe o que já saiu

Ele guarda duas coisas de cada arte publicada: o **sha1 do conteúdo** e o **nome do
arquivo**. Basta uma das duas bater para a arte contar como publicada.

Isso existe por causa de um acidente real: em 19/08/2026 as artes foram
reexportadas, todos os sha1 mudaram, e o robô achou que nenhuma tinha saído —
voltou a publicar da primeira. Só o sha1 não sobrevive a uma reexportação; só o
nome não sobrevive a uma renumeração. Os dois juntos sobrevivem aos dois casos.

O botão **Recomeçar fila** apaga esse registro de propósito. Numa pasta de feed
ele é o único jeito de republicar algo — e o painel avisa disso antes.

## Arquivos de configuração

### `midias/<categoria>/<pasta>/_config.json`

```json
{ "horarios": ["09:00", "19:30"], "loop": true, "ativo": true }
```

- `horarios`: hora local (America/Belem), `HH:MM`. Vários por pasta.
- `ativo: false`: pausa a pasta sem apagar nada.
- `loop: false`: para quando a fila acabar. **Só em story** — no feed é ignorado.
- `folgas: [0]`: dias da semana em que esta pasta não publica (`0` = domingo … `6` = sábado).
- `legenda` / `legendas`: `legenda` vale para a pasta inteira, `legendas: { "001.png": "…" }`
  sobrescreve por arte. Obrigatória no feed.
- `artes`: marcações de hora/data por arquivo. O painel escreve, você não precisa editar.

### `midias/_geral.json` — dias sem publicar, para todas as pastas

```json
{ "folgas": [0], "pausas": ["2026-12-25"], "pausarAte": "" }
```

Em dia parado o robô encerra sem publicar e sem mandar e-mail. A folga da pasta
**soma** com esta. Slot perdido não é recuperado: a fila só anda quando publica.

### `notificacoes.json` — quando o e-mail chega

```json
{
  "modo": "resumo",
  "horaResumo": "19:00",
  "sempreQueFalhar": true,
  "avisarFilaFeed": 5,
  "assunto": "{titulo}",
  "cabecalho": "",
  "rodape": ""
}
```

- `modo`: `resumo` (um e-mail por dia), `cada` (um por publicação) ou `nunca`.
- `horaResumo`: quando o resumo do dia fecha e sai.
- `sempreQueFalhar`: falha manda e-mail na hora, fora do resumo.
- `avisarFilaFeed`: avisa quando a fila do feed tiver esse tanto de dias ou menos. `0` desliga.
- `assunto`, `cabecalho`, `rodape`: seu texto. No assunto valem `{titulo}`, `{data}`,
  `{hora}`, `{quantidade}` e `{lista}`.

Cada relatório vira uma issue no repositório, e o GitHub manda o e-mail para quem
segue o repo. Sucesso vira issue já fechada — o e-mail chega igual, sem encher a lista.

## O painel e o atraso do Git

O painel roda **nesta máquina**; o robô roda no GitHub e escreve o `state.json` lá.
Sem puxar, o painel mostra a fila de dois dias atrás.

- **Buscar do robô** faz `git pull --rebase`. O painel também faz isso sozinho ao
  abrir e a cada 2 minutos. É só leitura.
- **Enviar** faz `add`, `commit` e `push`. Continua sendo um clique seu, de propósito:
  é o que coloca a arte no ar.

O selo no topo diz em qual dos três estados você está.

## Estrutura do repositório

| Arquivo | O que faz |
|---|---|
| `publish.mjs` | O robô. Roda no GitHub Actions a cada 15 min e decide o que publicar. |
| `agenda.mjs` | As regras de escolha, compartilhadas pelo robô e pelo painel. |
| `state.json` | O que já saiu. Escrito pelo robô, versionado. Não edite na mão. |
| `notificacoes.json` | Preferências de e-mail. |
| `painel/` | Servidor local (`server.mjs`) e interface (`index.html`). |
| `.github/workflows/stories.yml` | O cron e o envio do relatório. |

## Requisitos que quebram tudo se mudarem

- **O repositório precisa ser público.** A Meta baixa a arte por `raw.githubusercontent.com`.
- **Nunca ative o Git LFS.** A raw devolveria o ponteiro de texto no lugar da imagem.
- `IG_TOKEN` é Secret do repositório; `IG_USER_ID` é variable. O token vai sempre
  no header, nunca na URL — o log do Actions é público aqui.
- A API do Instagram **não agenda** story: a publicação acontece na hora em que o
  cron roda. Por isso a tolerância de 2h — o cron do GitHub atrasa.
