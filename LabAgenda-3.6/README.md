# LabAgenda — versão 3.6

Sistema escolar de agendamento de ambientes, com interface web, API Node.js e banco SQLite.

## Requisitos

- Windows 10/11
- Node.js **22.x**
- npm

## Executar localmente

1. Extraia o ZIP.
2. Abra a pasta `LabAgenda-3.6` no VS Code.
3. Abra **Terminal > Novo Terminal**.
4. Instale as dependências:

   ```powershell
   npm install
   ```

5. Inicialize o banco:

   ```powershell
   npm run db:init
   ```

6. Inicie o sistema:

   ```powershell
   npm run dev
   ```

7. Acesse http://localhost:3000

### Contas locais de demonstração

| Perfil | E-mail | Senha |
|---|---|---|
| Administrador | admin@labagenda.local | Admin@123 |
| Professor | professor@labagenda.local | Professor@123 |

Essas contas são exclusivamente para demonstração local. Altere as senhas e não publique credenciais de demonstração em um ambiente público.

## Funcionalidades disponíveis

- Login com senha protegida por hash e perfis de professor/administrador.
- Consulta de ambientes e criação de solicitações com várias aulas.
- Validação de dias úteis, duração de 50 minutos, intervalos, antecedência e conflitos.
- Aprovação e rejeição administrativa com justificativa.
- Cancelamento total e parcial, com validação de antecedência e justificativa excepcional.
- Expiração automática de solicitações pendentes, verificada a cada minuto.
- Cadastro de feriados e recessos e identificação de reservas aprovadas afetadas.
- Registro de decisões administrativas manter/cancelar; a decisão cancelar é apenas registrada, sem cancelar operacionalmente, enquanto PD-09 estiver pendente.
- Reorganização de aulas afetadas com validação de conflitos e preservação do histórico.
- Notificações internas, histórico, gestão de usuários e relatórios básicos.

## Configuração

Copie `.env.example` para `.env` e defina uma chave secreta forte em `JWT_SECRET`. Para produção, configure também `NODE_ENV=production` e `DB_PATH` apontando para um volume persistente.

**Atenção:** SQLite precisa estar em armazenamento persistente no provedor de hospedagem. Não coloque o banco em diretório temporário/efêmero. Faça backup periódico.

## Pendências documentais da versão 3.6

As pendências PD-01 a PD-11 continuam abertas. O sistema implementa o que está suficientemente definido e evita inventar regras para:
- PD-03: reservas já parcialmente canceladas afetadas posteriormente por feriados/recessos.
- PD-04: horários exatos da grade oficial; a tabela horária inicial é provisória.
- PD-05: filtros e detalhamento de relatórios.
- PD-06: indicador de leitura como regra de negócio. A interface oferece marcação simples de leitura, sem tratá-la como requisito definitivo.
- PD-07: critério de conclusão de reservas.
- PD-08: consecutividade das aulas reorganizadas.
- PD-09: cancelamento administrativo de reservas com várias aulas parcialmente afetadas. A decisão fica registrada, sem alterar o estado operacional.
- PD-01, PD-02 e PD-10: descrições/fluxos originais não recuperados.
- PD-11: matriz integral de rastreabilidade ainda não comprovada.

## Segurança e publicação

- Não envie `.env`, banco SQLite ou `node_modules` ao GitHub.
- Não use as senhas locais de demonstração em produção.
- Gere uma chave JWT forte e exclusiva para o ambiente de produção.
- Use hospedagem Node.js com volume persistente para o SQLite.
- Antes de disponibilizar ao professor, teste os dois perfis, os fluxos de reserva e o acesso público.

## Observações técnicas

A grade escolar exata ainda depende da validação PD-04. O sistema aplica duração de 50 minutos, dias úteis, intervalos conhecidos e a janela geral de funcionamento informada na documentação. O horário máximo geral foi mantido em 18:15, por ser o último horário informado; confirme a grade oficial antes de uso institucional.
