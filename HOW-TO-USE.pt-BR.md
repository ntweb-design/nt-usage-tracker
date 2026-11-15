# NT Usage Tracker — Como usar

[English](HOW-TO-USE.md) · **Português (Brasil)** · [Voltar ao README](README.pt-BR.md)

Tudo sobre instalar, ler e arrumar o widget, conectar cada provider e servidor, e onde ficam os seus dados.

> O app só lê. Ele nunca altera suas contas, nunca renova nem copia os logins dos CLIs, e não envia nada para lugar nenhum além das consultas de uso que cada provider já responde para o próprio CLI.

---

## Conteúdo

- [Instalação](#instalação)
- [Como ler o widget](#como-ler-o-widget)
- [Providers de IA](#providers-de-ia)
- [Este PC](#este-pc)
- [VPS](#vps)
- [Arrumando as boxes](#arrumando-as-boxes)
- [Menus e configurações](#menus-e-configurações)
- [Relatório de consumo e custo](#relatório-de-consumo-e-custo)
- [Privacidade: o que fica onde](#privacidade-o-que-fica-onde)
- [Problemas comuns](#problemas-comuns)
- [Compilando a partir do código](#compilando-a-partir-do-código)
- [Estrutura do projeto](#estrutura-do-projeto)

---

## Instalação

1. Baixe o `NT-Usage-Tracker-Setup-<versão>.exe` da [última release](https://github.com/ntweb-design/nt-usage-tracker/releases/latest) (ou [compile você mesmo](#compilando-a-partir-do-código)).
2. Execute. Ele instala só para o seu usuário do Windows, sem pedir permissão de administrador.
3. O instalador não é assinado, então o Windows SmartScreen avisa na primeira execução: escolha **Mais informações › Executar assim mesmo**.

O widget aparece na borda direita da tela, com um ícone na bandeja ao lado do relógio. Ele abre em inglês; para trocar para português, use **Language** no clique direito de qualquer box ou no menu da bandeja. Para abrir junto com o Windows, clique com o botão direito numa box › **Iniciar com o Windows**.

Requisitos: Windows 10 ou 11. As VPS usam o cliente OpenSSH que já vem no Windows (`C:\Windows\System32\OpenSSH\ssh.exe`).

## Como ler o widget

Cada ícone fica dentro de dois anéis:

| | Boxes de IA | Boxes do PC e das VPS |
|---|---|---|
| **Anel externo** | a janela longa (semanal ou mensal): quanto **resta** | a leitura principal: quanto está **em uso** |
| **Anel interno** | a janela de 5 horas: quanto **resta** | uma segunda leitura (veja cada box abaixo) |
| **Cor** | verde → âmbar com 30 % restando → vermelho com 10 % restando | verde → âmbar com 75 % em uso → vermelho com 90 % em uso |

- **Passe o mouse** num ícone para ver os detalhes: cada limite com o tempo até zerar, os tokens de hoje ou as leituras completas do recurso.
- **Clique** num ícone de IA para abrir o relatório de consumo daquele provider.
- Um **ponto vermelho** pede atenção (login vencido ou servidor offline). Um **ponto âmbar** indica que os números são de uma leitura mais antiga.
- Um ícone apagado ainda não tem o que mostrar.

## Providers de IA

Um provider aparece sozinho quando o CLI dele está instalado ou já deixou dados nesta máquina. Para esconder algum, use o botão direito › **Providers**.

| Provider | Limites | Consumo (tokens) |
|---|---|---|
| **Claude Code** | limites de 5 horas e semanal da sua conta, usando o login em `~/.claude/.credentials.json` | transcrições em `~/.claude/projects` |
| **Codex CLI** | limites de 5 horas e semanal da sua conta do ChatGPT (`~/.codex/auth.json`); sem internet, usa a última leitura dos logs do CLI | `~/.codex/sessions` |
| **Grok CLI** | a última checagem de créditos que o CLI gravou em `~/.grok/logs/unified.jsonl` (atualiza quando o CLI roda) | o mesmo log |
| **OpenCode** | plano OpenCode Go (5 horas, semanal, mensal), usando seu login no OpenCode Console (`opencode auth login`) ou sua chave do Go | `~/.local/share/opencode/opencode.db` |
| **Gemini (Antigravity)** | a cota do Google para o seu plano (5 horas e semanal, por grupo de modelos), usando o login que o `agy` guarda no Gerenciador de Credenciais do Windows ou em `~/.gemini/…oauth-token` | — |
| **Claude API** | orçamento mensal opcional contra o gasto do mês | a Usage and Cost API da organização (precisa de uma chave, veja abaixo) |

**Login.** O botão direito › **Connect account** (Conectar conta) abre um terminal com o comando de login do próprio CLI (`claude auth login`, `codex login`, `grok login`, `opencode auth login`, `agy`). O CLI faz o login oficial no navegador e o widget pega a sessão na atualização seguinte. O app não tem login próprio.

**Sobre o Gemini.** O token de acesso do Google dura uma hora e só o `agy` o renova. Por isso o widget guarda a última leitura e mostra "Última leitura há …" quando o token vence. Na prática isso basta: a cota só muda quando você usa o `agy`, e é justamente aí que ele renova o token.

### Claude API

A Claude API (Console) não tem um login de CLI para aproveitar, então precisa de uma chave. Use o botão direito › **Conectar conta › Claude API (chave Admin)…** e cole:

- uma **chave Admin** (`sk-ant-admin…`, criada por um admin da organização em Console › Settings › Admin keys), ou
- a **chave pessoal** (`sk-ant-usr…`) de uma conta com papel de admin que **não esteja presa a um workspace**.

A chave é testada com a Anthropic antes de ser salva:

- **401**: a chave é inválida, expirou ou foi removida. Toda chave tem uma validade escolhida na criação.
- **403**: a conta não é admin, ou a chave está presa a um workspace.

A chave salva é criptografada pelo Windows (DPAPI) e só é passada ao coletor em memória. Informe um **orçamento mensal** em US$ para ganhar um anel com ele. A Anthropic processa esses dados com atraso de umas 4 horas (até 24 h), então o dia de hoje sempre aparece incompleto. O tooltip diz até quando os dados estão atualizados.

## Este PC

| Ícone | Anel externo | Anel interno |
|---|---|---|
| CPU | uso total | núcleo mais usado |
| Memória | RAM em uso | commit (RAM + swap) |
| GPU | uso | VRAM |

CPU e RAM vêm do Node. GPU, VRAM e commit vêm dos contadores de desempenho do Windows, lidos por um pequeno script PowerShell, então funciona com GPU de qualquer fabricante. Liga e desliga em botão direito › **Monitor do PC**.

## VPS

Cada servidor ganha a sua própria box:

| Ícone | Anel externo | Anel interno |
|---|---|---|
| CPU | uso total | núcleo mais usado |
| Memória | RAM em uso | swap |
| Disco | `/` ocupado | disco ocupado (I/O) |

O tooltip também mostra a carga, a rede (entrada e saída), o nome do host, o sistema e o tempo no ar. Um servidor offline fica apagado com um ponto vermelho, e o tooltip diz o motivo (por exemplo, "a VPS não aceitou a chave" ou "host não encontrado"). O app reconecta sozinho.

**Adicionando um servidor:** botão direito › **VPS › Adicionar VPS…**

1. **Nome**: o rótulo que aparece acima da box.
2. **Host**: um IP, um nome do Tailscale ou qualquer `Host` do seu `~/.ssh/config`. Porta e usuário são opcionais.
3. **Chave**: escolha um dos quatro modos.
   - **Padrão do SSH**: o que o `ssh` do Windows já usaria (`~/.ssh`, ssh-agent, Tailscale SSH).
   - **Arquivo de chave privada**: qualquer arquivo de chave sem senha (ou carregado no ssh-agent).
   - **Colar chave privada**: fica salva só nesta máquina, na pasta de dados do app, com acesso só do seu usuário do Windows.
   - **Gerar chave nova pelo app**: cria um par ed25519 e mostra a chave pública, com um botão **Copiar comando**. Rode esse comando no servidor, pelo console do provedor ou numa sessão SSH que já funcione; ele coloca a chave no `~/.ssh/authorized_keys`.
4. Clique em **Testar conexão** e depois em **Salvar**.

Como funciona: uma sessão SSH fica aberta por servidor e lê o `/proc` a cada 2 segundos com um pequeno loop de shell. **Nada é instalado no servidor, e não precisa ser root.** Na primeira conexão, a chave do servidor é guardada no `known_hosts` do próprio app; se ela mudar depois, a conexão é recusada.

O submenu de cada servidor (botão direito › **VPS**) tem **Mostrar**, **Editar…**, **Reconectar** e **Remover…**.

## Arrumando as boxes

Arraste qualquer box com o mouse.

- **Em qualquer lugar**: a box fica onde você soltar.
- **Bordas da tela**: perto de uma borda, a box gruda nela. Nas laterais ela fica vertical; em cima e embaixo, horizontal. Perto da ponta da borda ela vai para o canto; perto do meio, centraliza na borda.
- **Centro da tela**: solta perto da linha de centro horizontal ou vertical, ela se alinha nessa linha.
- **Outras boxes**: perto de qualquer lado de outra box (em cima, embaixo, esquerda ou direita), ela encaixa ali. Ao longo daquele lado, ela vai para o canto mais próximo, para o centro ou para uma grade em passos de ícone. A grade deixa uma box ficar um ou dois ícones para fora da outra, para montar escadinhas, pódios ou triângulos. Uma box nunca encaixa onde cobriria outra.
- Os encaixes **deslizam** até o lugar em vez de pular.

Boxes encaixadas formam um grupo:

- Arrastar a box principal do grupo (a que não está presa a nenhuma) leva o grupo todo.
- Arrastar qualquer outra box a solta, junto com as boxes presas nela.

Tamanho da grade: botão direito › **Grade de encaixe** › 1 ícone, meio ícone, ou só cantos e centro.

Cada box tem um nome pequeno acima dos medidores ("IA", "Este PC" ou o nome do servidor). Troque com botão direito › **Renomear esta box…**, e esconda todos com **Mostrar nomes das boxes**.

## Menus e configurações

**Botão direito em qualquer box:**

| Item | O que faz |
|---|---|
| Abrir relatório / Atualizar agora | abre o relatório de consumo; lê tudo de novo na hora |
| Providers | mostra ou esconde cada provider de IA |
| Conectar conta | faz login num CLI, ou informa a chave da Claude API |
| Monitor do PC | mostra ou esconde a box do PC |
| VPS | adiciona, edita, mostra/esconde, reconecta ou remove servidores |
| Renomear esta box… / Mostrar nomes das boxes / Grade de encaixe | nomes das boxes e encaixe |
| Idioma | English ou Português (Brasil) |
| Iniciar com o Windows / Abrir pasta de dados / Sair | |

**Ícone da bandeja** (clique nele): relatório de consumo, esconder/mostrar o widget, transparência, modo claro, idioma, sobre e fechar.

Os limites são atualizados a cada 90 segundos. Posição, transparência, tema, idioma e grade ficam salvos.

## Relatório de consumo e custo

Clique num ícone de IA ou use **Abrir relatório**. Dá para alternar entre tokens e custo, entre hoje, 7 dias e 30 dias, e entre todos os providers ou só um. O detalhamento agrupa o consumo por modelo, por dia ou por provider.

- Na **Claude API**, o custo é o valor real que a Anthropic informa, já com descontos.
- Nos **CLIs**, o custo é uma **estimativa** a preço de tabela da API, por família de modelo. Assinaturas não são cobradas por token, então leia como "quanto isso custaria na API". Ajuste os preços no `pricing.json` da pasta de dados; modelos sem regra aparecem sem custo.
- O OpenCode informa o próprio custo de cada mensagem, e esse valor é usado como está.

## Privacidade: o que fica onde

Nada pessoal fica na pasta do programa nem neste repositório. Tudo o que o app guarda fica no seu perfil do Windows:

| Onde | O quê |
|---|---|
| `%APPDATA%\nt-usage-tracker\state.json` | posições das boxes, configurações, a lista de servidores (nome, host, usuário, porta e o caminho de um arquivo de chave; nunca a chave em si) |
| `%APPDATA%\nt-usage-tracker\claude-api-admin.key` | a chave da Claude API, criptografada pelo Windows (DPAPI) |
| `%APPDATA%\nt-usage-tracker\ssh\` | chaves geradas pelo app ou coladas por você (acessíveis só pelo seu usuário) e o `known_hosts` do app |
| `%APPDATA%\nt-usage-tracker\cache\`, `pricing.json` | cache do consumo já processado e a tabela de preços |

O app **lê**, e nunca grava, estes logins: `~/.claude`, `~/.codex`, `~/.grok`, o banco de dados do OpenCode, `~/.gemini`, a entrada `gemini:antigravity` do Gerenciador de Credenciais do Windows e o seu `~/.ssh/config`.

As conexões de rede vão só para o endpoint de uso de cada provider (os mesmos que o CLI dele usa), para a Anthropic no caso da Claude API, e por SSH para os servidores que você adicionar.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Um provider não aparece | O CLI dele não está no `PATH` e ainda não deixou dados. Rode o CLI uma vez. |
| "Login expirado" | Abra aquele CLI, que renova o próprio login. O widget nunca renova tokens. |
| O Gemini mostra "Última leitura há …" | Normal depois que o token de 1 hora vence; atualiza na próxima vez que você usar o `agy`. |
| O OpenCode mostra só consumo | A conta não tem assinatura do OpenCode Go, ou você não está logado no OpenCode Console. |
| Claude API: 401 | A chave expirou ou foi removida. Crie outra (com validade longa). |
| Claude API: 403 | Use uma chave Admin, ou a chave pessoal de um admin que não esteja presa a um workspace. |
| VPS: "não aceitou a chave" | A chave pública não está no `~/.ssh/authorized_keys` daquele usuário. Use **Copiar comando** na janela da VPS. |
| VPS: "host não encontrado" | Confira o nome ou o IP, ou ligue o Tailscale. |
| VPS: "a chave tem senha" | Use uma chave sem senha, ou carregue-a no ssh-agent. |
| Aviso do SmartScreen | O instalador não é assinado: **Mais informações › Executar assim mesmo**. |

## Compilando a partir do código

```bash
npm install
npm start            # roda o widget
npm run collect      # mostra no terminal o que o coletor encontra
npm run dist         # gera o instalador em dist/
```

Se o `npm install` não baixar o binário do Electron, rode `node node_modules/electron/install.js`.

Opções de desenvolvimento (variáveis de ambiente):

| Variável | Efeito |
|---|---|
| `UT_DATA=<pasta>` | usa outra pasta de configurações, para rodar uma cópia de desenvolvimento ao lado da instalada |
| `UT_SHOT=<pasta>` | salva cada janela em PNG e fecha |
| `UT_DRAGTEST=1` | roda os testes de arrastar e encaixar com um cursor simulado |
| `ANTHROPIC_ADMIN_KEY=…` | chave da Claude API para o `npm run collect` |

## Estrutura do projeto

```
src/
  main.js        janelas, arrastar e encaixar, tooltip, menus, janelas de VPS e de configuração
  i18n.js        textos da interface (inglês, com a tabela em português do Brasil)
  sysmon.js      monitor do PC (+ sysmon.ps1 para os contadores de GPU/VRAM/commit)
  vpsmon.js      monitor das VPS por SSH, geração de chave e teste de conexão
  preload.js     a ponte entre as janelas e o processo principal
  collect/       um coletor por provider, rodando numa worker thread
    vault.ps1    lê o login do Antigravity no Gerenciador de Credenciais do Windows
  ui/            boxes do widget, tooltip, relatório, menu da bandeja e janelas pequenas
scripts/         gerador do ícone
build/           ícone do app
```
