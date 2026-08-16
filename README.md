# Stories Toptech — agendador automático

Publica stories no @toptech_pa em horários fixos, todo dia, sem abrir o Business Suite.

## Como usar no dia a dia

Só isso: jogue as artes dentro de uma pasta de `stories/` e faça push.

```
stories/
  manha/          08:50                        story
  produtos/       09:30 11:00 11:30 12:00 12:30  story
  tarde/          12:00 15:00 18:00            story
  campanha/       10:15 13:30 16:30            story  (campanha diagnóstico, 1080x1920)
  feed-campanha/  17:30                        FEED   (mesma campanha, 1080x1350)
```

Todos os horários ficam dentro do comercial (nada depois das 18:00).

- A ordem é **alfabética/numérica pelo nome do arquivo**. Use `001`, `002`, `003`.
- Cada horário consome **um** arquivo e avança pro próximo.
- Quando a fila acaba, volta ao primeiro (loop) e **abre uma issue avisando** que é hora de renovar as artes.
- Criar uma pasta nova (ex: `stories/noite/`) com um `_config.json` já basta — não precisa mexer no workflow.

### `_config.json`

```json
{ "horarios": ["09:00", "19:30"], "loop": true, "ativo": true }
```

- `horarios`: hora local (America/Belem), formato `HH:MM`. Vários por pasta.
- `loop: false`: para quando a fila acabar em vez de recomeçar.
- `ativo: false`: pausa a pasta sem apagar nada.
- `tipo: "feed"`: publica no feed em vez de story. Sem esse campo, é story.
- `folgas: [0]`: dias da semana em que esta pasta não publica. `0` = domingo … `6` = sábado (também aceita `"dom"`, `"seg"`…).

- `legenda` / `legendas`: texto que acompanha a publicação — `legenda` vale para a pasta inteira, `legendas: { "001.png": "…" }` sobrescreve por arte. Editável no painel.

### Dias sem publicar (vale para todas as pastas)

`stories/_geral.json`:

```json
{ "folgas": [0], "pausas": ["2026-12-25"], "pausarAte": "2026-08-20" }
```

- `folgas`: dias da semana, toda semana.
- `pausas`: datas soltas (feriado, viagem).
- `pausarAte`: para tudo até essa data, inclusive.

Em dia parado o robô encerra a execução sem publicar nada e sem mandar e-mail. A folga da pasta **soma** com esta — não substitui. Tudo isso se edita no painel, no bloco "Sem publicar".

Slot perdido não é recuperado: se domingo é folga, o story de domingo não sai na segunda — a fila só anda quando publica.

### Pasta de feed

```json
{
  "tipo": "feed",
  "horarios": ["17:30"],
  "loop": false,
  "legenda": "texto usado quando a arte não tem legenda própria",
  "legendas": { "01.png": "legenda desta arte" }
}
```

- **Use `loop: false` no feed.** Story some em 24h, post de feed fica — republicar a mesma arte polui o perfil.
- `legendas` é por nome de arquivo; `legenda` é o texto de reserva. Sem nenhum dos dois, o post sai sem legenda e uma issue avisa.
- Formato do feed: 1080x1350 (4:5), 1080x1080 ou 1080x566. Vídeo de feed vira Reels.
- No painel, o botão **leg** de cada arte (ou "Legenda padrão" na pasta) escreve esses campos.

### Painel local

`Abrir painel.command` → <http://127.0.0.1:4751>. Ele mostra:

- **Hoje**: a régua do dia, com a arte prevista em cada horário e a linha do "agora". A previsão roda o mesmo algoritmo do robô (`agenda.mjs`), então bate com o que vai sair.
- **Atenção**: pasta vazia, arte fora de formato, feed sem legenda, fila prestes a dar a volta.
- **Sem publicar**: dias da semana, datas soltas e "parar até".
- **Já saiu**: últimas 80 publicações, gravadas em `state.json` por `_historico`.
- **Pastas**: horários, folga da pasta, legendas, ordem das artes e upload por arrastar.

### Formatos

`.jpg .jpeg .png` e `.mp4 .mov`. Story = **1080x1920**, imagem até 8 MB, vídeo até 60s.
Redimensionar antes: `sips --resampleHeightWidthMax 1920 arquivo.jpg`

## Setup (uma vez)

1. Criar o repositório **público** no GitHub (o Instagram precisa baixar a mídia por URL pública).
2. `Settings → Secrets and variables → Actions`:
   - Secret `IG_TOKEN` — token do Usuário de Sistema (Business Manager → Usuários do sistema → gerar token com `instagram_content_publish` + `instagram_basic`, sem expiração).
   - Variable `IG_USER_ID` — `17841458291127780` (opcional, é o default).
3. `Settings → Actions → General → Workflow permissions` → **Read and write**.
4. Testar: aba Actions → "Stories Toptech" → Run workflow → marcar **dry_run** → conferir o log.

## Por que o token não vaza num repo público

- **Secret não é código.** `IG_TOKEN` fica no cofre do GitHub, fora do repositório. Quem clona o repo não recebe nada — só vê `${{ secrets.IG_TOKEN }}` no YAML.
- **O log do Actions é público, o valor não.** O GitHub mascara qualquer ocorrência do secret na saída como `***`, mesmo se um erro tentasse imprimi-lo.
- **O script nunca coloca o token na URL** — vai no header `Authorization`. URL aparece em mensagem de erro de rede; header não.
- **Fork não alcança secret.** Workflow disparado por PR de fork roda sem acesso ao cofre. E `workflow_dispatch` só quem tem permissão de escrita consegue acionar.
- Regra que continua valendo: se a token for colada em qualquer arquivo por engano, **revogar e gerar outra** — apagar a linha depois do push não desfaz nada.

O que fica público de verdade: as artes em `stories/`, os `_config.json` (horários) e o `state.json`. Nada disso é sensível.

## Avisos importantes

- Não coloque em `stories/` nada de cliente ou material interno — é conteúdo que vai pro ar mesmo.
- **Nunca ative Git LFS neste repo.** A `raw.githubusercontent` passaria a devolver um ponteiro de texto no lugar da imagem e a publicação falharia.
- O cron do GitHub Actions pode atrasar 5–15 min. O script aceita até 59 min de atraso e ainda publica; passou disso, pula o slot daquele dia.
- Se a publicação falhar (token expirada, mídia fora de padrão), o índice **não avança** — ele tenta de novo na próxima rodada de 15 min e abre uma issue.
- `state.json` é escrito pelo bot. Não edite à mão sem necessidade (dá conflito no push).

## Limitação que não dá pra contornar

A API do Instagram não tem agendamento de story — só publicação imediata. O "Programar" do Business Suite é feature do painel, não da API. Por isso existe este cron: ele chama a API na hora certa.
