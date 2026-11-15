# MultiSocial

Todas as suas redes sociais em um só app para Windows, com abas no estilo navegador.

## Recursos

- **Início estilo smartphone**: relógio, busca, grade de ícones e dock com favoritos (botão direito > "Fixar no dock").
- **19 redes prontas**: WhatsApp, Instagram, Facebook, X (Twitter), Snapchat, Reddit, Gmail, Telegram, TikTok, YouTube, Discord, Threads, LinkedIn, Pinterest, Twitch, Bluesky, Tumblr, Kwai e Kick, além de **sites personalizados** (botão "Adicionar"), que ganham a logo do próprio site.
- **Login separado por rede**, salvo no PC: você entra uma vez e continua logado.
- **Abas**: arrastar para reordenar, botão do meio fecha, botão direito tem mais opções, contador de mensagens não lidas em cada aba, no ícone do início, na bandeja e na barra de tarefas.
- **Botão direito nas páginas**:
  - Links: abrir em nova aba, em nova janela, em mini janela flutuante ou no navegador padrão.
  - Imagens: salvar, salvar como, copiar imagem ou endereço. Funciona até no Instagram, onde a imagem fica coberta por outras camadas.
  - Vídeos: Picture-in-Picture, play/pause, loop, controles, mudo, velocidade, salvar vídeo (link direto) ou **gravar o vídeo em tempo real** quando o site só transmite por streaming (Instagram, X…).
  - Página: abrir a aba em nova janela, mini janela sempre no topo, silenciar, captura de tela, zoom e inspecionar.
- **Bandeja**: na primeira vez em que você fecha a janela, o app pergunta se deve minimizar para a bandeja. Depois dá para mudar em Configurações > "Ao fechar a janela".
- **Notificações** das redes. Clicar numa notificação abre a aba certa.
- **Reprodução em segundo plano por rede**: YouTube, Twitch e Kick continuam tocando ao trocar de aba/minimizar; as outras pausam (configurável por rede).
- **Segurança**: cookies criptografados (DPAPI do Windows), câmera/microfone/tela só com permissão, chaves de acesso (passkeys) bloqueadas por padrão.
- **Atualizações**: verifica as Releases do GitHub ao abrir e a cada 6 horas, baixa a nova versão e reinicia já atualizado (portable ou instalador).
- Downloads com progresso, buscar na página, zoom salvo por rede, tema claro e escuro, iniciar com o Windows.

## Atalhos

| Atalho | Ação |
|---|---|
| Ctrl+1 | Menu inicial |
| Ctrl+2 … Ctrl+8 | Aba 2 … 8 |
| Ctrl+9 | Última aba |
| Ctrl+Tab / Ctrl+Shift+Tab | Próxima / anterior |
| Ctrl+W | Fechar aba |
| Ctrl+Shift+T | Reabrir aba fechada |
| Ctrl+T | Início + pesquisar rede |
| Ctrl+F | Buscar na página |
| Ctrl+R / F5 | Recarregar |
| Alt+← / Alt+→ | Voltar / avançar |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom |
| Ctrl+Shift+N | Aba atual em nova janela |
| Ctrl+Shift+M | Mini janela flutuante |
| Ctrl+Shift+S | Captura de tela |
| Ctrl+, | Configurações |
| F11 / F12 | Tela cheia / DevTools |

## Rodar e compilar

```bash
npm install
npm start            # roda em modo desenvolvimento
npm run dist         # gera instalador + portable em dist/ (no Windows)
```

O workflow `.github/workflows/build.yml` compila o instalador e o portable no GitHub Actions a cada push na `main`.

## Observações

- O Gmail e o "Entrar com Google" usam identificação de Firefox para o Google aceitar o login. Se mesmo assim ele bloquear, entre com e-mail e senha da própria rede.
- Para publicar uma atualização: aumente `version` no package.json, escreva as novidades no CHANGELOG.md e faça push na `main`. O GitHub Actions compila e cria a Release `vX.Y.Z` sozinho, e o app avisa os usuários.
- Os dados ficam em `%APPDATA%\MultiSocial` e os downloads em `Downloads\MultiSocial`.
- A gravação de vídeo acontece em tempo real: um vídeo de 1 minuto leva 1 minuto para gravar. O arquivo é salvo em `.webm`.
