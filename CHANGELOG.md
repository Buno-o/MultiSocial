## Novidades da v1.3.0

- **Reprodução em segundo plano por rede**: cada site pode continuar tocando ou pausar quando você troca de aba, minimiza ou manda para a bandeja. YouTube, Twitch e Kick continuam tocando por padrão; as outras pausam. Mude em Configurações > Redes sociais (chave "2º plano") ou com o botão direito na aba / no ícone do início.
- **Cookies criptografados**: os cookies de login de todas as redes agora são gravados criptografados com uma chave protegida pelo Windows (DPAPI), presa à sua conta de usuário. Logins antigos continuam funcionando.
- **Executável mais protegido**: o app não pode mais ser usado como Node.js genérico, ignora variáveis/flags de depuração do Node e só carrega o próprio código empacotado.
