// Lista de redes sociais / IAs exibidas no menu inicial.
// bg: true      = continua reproduzindo em segundo plano por padrão
// nativeMedia: true = o site já tem barra de tempo e volume (a barra do app não aparece no modo automático)
// alive: true   = nunca é suspensa para economizar RAM (mensageiros: precisam das notificações)
// domains       = domínios que pertencem à rede (links para outros domínios abrem no navegador padrão)
// color: [cor1, cor2] gradiente usado no ícone quando a logo não carrega.
module.exports = [
  { id: 'whatsapp',  name: 'WhatsApp',  url: 'https://web.whatsapp.com/',        color: ['#25D366', '#128C7E'], glyph: 'W', alive: true, domains: ['whatsapp.com', 'whatsapp.net'] },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/',       color: ['#F58529', '#8134AF'], glyph: 'Ig', domains: ['instagram.com', 'cdninstagram.com', 'fbcdn.net', 'facebook.com'] },
  { id: 'facebook',  name: 'Facebook',  url: 'https://www.facebook.com/',        color: ['#1877F2', '#0B4FB3'], glyph: 'f', nativeMedia: true, domains: ['facebook.com', 'fb.com', 'fbcdn.net', 'messenger.com', 'meta.com'] },
  { id: 'x',         name: 'X (Twitter)', url: 'https://x.com/',                 color: ['#1d1d1d', '#000000'], glyph: 'X', nativeMedia: true, domains: ['x.com', 'twitter.com', 'twimg.com'] },
  { id: 'snapchat',  name: 'Snapchat',  url: 'https://web.snapchat.com/',        color: ['#FFFC00', '#F5D800'], glyph: 'S', dark: true, domains: ['snapchat.com'] },
  { id: 'reddit',    name: 'Reddit',    url: 'https://www.reddit.com/',          color: ['#FF4500', '#D93A00'], glyph: 'R', nativeMedia: true, domains: ['reddit.com', 'redd.it', 'redditmedia.com'] },
  { id: 'gmail',     name: 'Gmail',     url: 'https://mail.google.com/mail/u/0/', color: ['#EA4335', '#C5221F'], glyph: 'M', ua: 'firefox', alive: true,
    icon: 'https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico', domains: ['google.com', 'gmail.com', 'googleusercontent.com'] },
  { id: 'telegram',  name: 'Telegram',  url: 'https://web.telegram.org/a/',      color: ['#37AEE2', '#1E96C8'], glyph: 'T', alive: true, domains: ['telegram.org', 't.me'] },
  { id: 'tiktok',    name: 'TikTok',    url: 'https://www.tiktok.com/',          color: ['#25F4EE', '#FE2C55'], glyph: 'Tk', nativeMedia: true, domains: ['tiktok.com', 'tiktokv.com'] },
  { id: 'youtube',   name: 'YouTube',   url: 'https://www.youtube.com/',         color: ['#FF0000', '#C40000'], glyph: 'Yt', bg: true, nativeMedia: true, domains: ['youtube.com', 'youtu.be'] },
  { id: 'discord',   name: 'Discord',   url: 'https://discord.com/app',          color: ['#5865F2', '#404EED'], glyph: 'D', alive: true, nativeMedia: true, domains: ['discord.com', 'discord.gg', 'discordapp.com'] },
  { id: 'threads',   name: 'Threads',   url: 'https://www.threads.com/',         color: ['#2b2b2b', '#000000'], glyph: '@', domains: ['threads.com', 'threads.net', 'instagram.com'] },
  { id: 'linkedin',  name: 'LinkedIn',  url: 'https://www.linkedin.com/',        color: ['#0A66C2', '#004182'], glyph: 'in', nativeMedia: true, domains: ['linkedin.com', 'licdn.com'] },
  { id: 'pinterest', name: 'Pinterest', url: 'https://www.pinterest.com/',       color: ['#E60023', '#AD081B'], glyph: 'P', domains: ['pinterest.com', 'pinterest.com.br', 'pinimg.com'] },
  { id: 'twitch',    name: 'Twitch',    url: 'https://www.twitch.tv/',           color: ['#9146FF', '#6441A5'], glyph: 'Tw', bg: true, nativeMedia: true, domains: ['twitch.tv'] },
  { id: 'bluesky',   name: 'Bluesky',   url: 'https://bsky.app/',                color: ['#1185FE', '#0560C9'], glyph: 'B', nativeMedia: true, domains: ['bsky.app', 'bsky.social'] },
  { id: 'tumblr',    name: 'Tumblr',    url: 'https://www.tumblr.com/',          color: ['#36465D', '#1F2A38'], glyph: 't', domains: ['tumblr.com'] },
  { id: 'kwai',      name: 'Kwai',      url: 'https://www.kwai.com/',            color: ['#FF8A00', '#FF5000'], glyph: 'K', domains: ['kwai.com'] },
  { id: 'kick',      name: 'Kick',      url: 'https://kick.com/',                color: ['#53FC18', '#2FB800'], glyph: 'K', dark: true, bg: true, nativeMedia: true, domains: ['kick.com'] },

  // ----- IAs (abre direto na conversa) -----
  { id: 'chatgpt',    name: 'ChatGPT',    url: 'https://chatgpt.com/',                color: ['#10A37F', '#0B7A5F'], glyph: 'G', ai: true, domains: ['chatgpt.com', 'openai.com'] },
  { id: 'claude',     name: 'Claude',     url: 'https://claude.ai/new',               color: ['#D97757', '#B85C3D'], glyph: 'C', ai: true, domains: ['claude.ai', 'anthropic.com'] },
  { id: 'gemini',     name: 'Gemini',     url: 'https://gemini.google.com/app',       color: ['#4285F4', '#9B72CB'], glyph: 'Ge', ai: true, ua: 'firefox', domains: ['google.com'] },
  { id: 'copilot',    name: 'Copilot',    url: 'https://copilot.microsoft.com/',      color: ['#2AA0F0', '#7A5AF8'], glyph: 'Co', ai: true, domains: ['microsoft.com', 'bing.com', 'live.com'] },
  { id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/',          color: ['#20808D', '#145C66'], glyph: 'Px', ai: true, domains: ['perplexity.ai'] },
  { id: 'deepseek',   name: 'DeepSeek',   url: 'https://chat.deepseek.com/',          color: ['#4D6BFE', '#2F4BD9'], glyph: 'Ds', ai: true, domains: ['deepseek.com'] },
  { id: 'grok',       name: 'Grok',       url: 'https://grok.com/',                   color: ['#2b2b2b', '#000000'], glyph: 'Gk', ai: true, domains: ['grok.com', 'x.ai', 'x.com'] },
  { id: 'mistral',    name: 'Le Chat',    url: 'https://chat.mistral.ai/chat',        color: ['#FF7000', '#E24A00'], glyph: 'Mi', ai: true, domains: ['mistral.ai'] }
];
