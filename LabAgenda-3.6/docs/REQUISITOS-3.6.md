# LabAgenda — referência de requisitos

Versão oficial de referência: **3.6 — Revisão final**.

Este projeto implementa os comportamentos suficientemente definidos na documentação consolidada recebida. As pendências PD-01 a PD-11 permanecem abertas e não devem ser consideradas resolvidas pelo código.

## Decisões que precisam permanecer explícitas

- CA09 verifica comunicação; CA12 verifica registro da decisão; CA18 verifica preservação dos dados.
- Administrador e professor consultam suas próprias notificações em UC17.
- Enquanto PD-09 estiver pendente, a decisão administrativa de cancelar é registrada, mas não executa cancelamento nem altera o estado operacional.
- Reorganização excepcional é exclusiva do administrador e só pode tratar aulas efetivamente afetadas por feriado/recesso cadastrado posteriormente.
- Reorganização deve ser integralmente validada antes da gravação; não pode haver gravação parcial.
- A grade de horários é provisória até validação PD-04.
