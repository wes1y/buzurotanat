# Área administrativa

O painel fica em `https://rotasnatal.com.br/use-admin` (no computador: `http://localhost:8080/use-admin/`).
O endereço pode ser trocado com `BUZU_PAINEL_CAMINHO` no servidor.

O **editor do mapa** fica em `/use-admin/editor` (link "Editor do mapa" no menu do painel). Ele é feito para
computador e é o único lugar onde dá para editar linhas, traçados e paradas: o site público não tem
mais ferramentas de edição. Tudo o que é feito no editor fica num rascunho deste navegador até alguém
clicar em **Publicar** (o servidor guarda uma cópia antes de publicar). A **Prévia** abre o site com o
rascunho (`/?previa=1`).

## Configuração (`.env` ou variáveis da hospedagem — nunca no Git)

| Variável | O que é |
| --- | --- |
| `BUZU_PAINEL_CAMINHO` | Endereço do painel (padrão: `use-admin`). |
| `BUZU_ADMIN_USUARIOS` | Contas, separadas por `;`. |
| `BUZU_PUBLIC_READONLY` | `1` desliga a área administrativa. |

Cada conta é uma linha `usuario:Nome:hash-da-senha[:chave-do-autenticador]`.
A senha nunca fica salva, só o hash dela (scrypt).

## Fase atual: testes (só usuário e senha)

**Configurar as contas (Wesly, Felipinho ou na hospedagem):** na pasta do projeto, rode

```
npm run admin:contas
```

O script já sabe as contas (`wesly` e `felipinho`), pede só a senha de cada uma (combinadas em
particular, nunca no Git) e grava o `.env` sozinho. Depois é só reiniciar o servidor (`npm start`).
Se a hospedagem usa variáveis de ambiente, o script também mostra as linhas prontas para colar.
Na hospedagem dá para rodar sem perguntas: `node scripts/admin/configurar-contas.js --wesly=SENHA --felipinho=SENHA`.

As contas `wesly` e `felipinho` estão **sem** a chave do autenticador (3 partes na linha), então o
login pede só usuário e senha. Os limites de tentativas, a sessão protegida e o log de acessos
continuam funcionando normalmente.

## Antes do lançamento: ligar a verificação em duas etapas

1. Cada um roda no próprio computador: `node scripts/admin/criar-usuario.js`
   (senha forte de 12+ caracteres e cadastro da chave no app autenticador do celular).
2. O script mostra a linha da conta (4 partes). Mande a linha direto para quem cuida da
   hospedagem, sem colar em chats, grupos ou prints.
3. Troque as linhas antigas de `BUZU_ADMIN_USUARIOS` pelas novas e reinicie o servidor.
4. Se quiser, troque o endereço do painel com `BUZU_PAINEL_CAMINHO` (algo difícil de adivinhar).

Assim que **alguma** conta tiver a chave do autenticador, o campo "Código do app autenticador"
volta a aparecer no login, e as contas com chave passam a exigir o código.

Uma conta do Felipinho com verificação em duas etapas já foi criada e está guardada como
comentário no `.env` local (`BUZU_ADMIN_USUARIOS_LANCAMENTO`). Como a chave dela apareceu numa
conversa, gere uma nova no lançamento.

## Dados do painel

Ficam em `dados-admin/` (fora do Git e bloqueado para acesso pelo navegador):
`acessos.jsonl` (entradas), `avisos.json`, `notas.json` e `estatisticas.json` (contagens anônimas).
O log de alterações continua em `dados/auditoria-admin.jsonl`.

## Banco de dados (PostgreSQL) e mudanças pelo GitHub

Com `DATABASE_URL` definido, o banco guarda o que é editado e publicado no painel. A cada início
(deploy), o servidor **restaura do banco** `linhas.json`, `paradas.json`, `linha_paradas.json` e
`lote-1/2.geojson`, por cima dos arquivos do GitHub.

Por isso, quem mudar esses arquivos direto no código (à mão ou por script) precisa gerar uma
**migração de dados** antes do commit:

```
npm run dados:migracao -- "o que mudou"
```

Ela cria `dados/migracoes/AAAA-MM-DD-....json` só com o que mudou (por linha, parada, traçado e
grupo linha+dia de vínculos). No deploy, depois de restaurar o banco, o servidor aplica as
migrações que ainda não rodaram e grava o resultado no banco (tabela `buzu_migracoes` registra as
já aplicadas). O resto continua como está no banco, inclusive o que foi editado no painel.
Se a mesma linha/parada foi editada nos dois lugares, vale a versão da migração.

Mudanças feitas pelo editor do painel e **publicadas** não precisam de migração.

## Importar traçado do Moovit

No editor do mapa (`/use-admin/editor`): abra a linha e o dia, e em *Arquivos e outros dias*
clique em **Importar do Moovit**. Na primeira vez, arraste o botão *Exportar para o BuzuRota* para
a barra de favoritos. No editor do Moovit, abra a viagem ativa da linha (`/editor/trip/…`),
clique no favorito e escolha o arquivo baixado no BuzuRota.

Do Moovit vêm só o **caminho** e as **paradas**: horários e frequências continuam os do edital.
Paradas do Moovit que não existem no BuzuRota (nenhuma a até 25 m) são criadas ao salvar, com
origem `moovit`; as que já existem são ligadas à linha. A senha do Moovit nunca passa pelo BuzuRota.
