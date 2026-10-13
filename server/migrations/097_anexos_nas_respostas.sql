-- ═══════════════════════════════════════════════════════════════════════════
--  097 · Anexos nas respostas do agente (4º momento da Késsia, item 2 — 13/10/2026)
--
--  O agente anexa PDF ou imagem (ou cola um print) na resposta ao cliente. O arquivo sobe antes (fica "solto", fila_id NULL) e é ligado à resposta
--  quando ela entra em `respostas_fila`; o envio em segundo plano lê daqui e anexa ao e-mail. Arquivo solto com mais de 1 dia é descartado pela API.
--  Só cria tabela e índices. Idempotente.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS email_ia.respostas_anexos (
  id             bigserial PRIMARY KEY,
  caso_id        bigint NOT NULL REFERENCES email_ia.suporte_escalado(id) ON DELETE CASCADE,
  fila_id        bigint REFERENCES email_ia.respostas_fila(id) ON DELETE CASCADE,
  nome           text NOT NULL,
  mime_type      text NOT NULL,
  tamanho_bytes  integer NOT NULL CHECK (tamanho_bytes > 0),
  conteudo       bytea NOT NULL,
  criado_por     text,
  criado_em      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS respostas_anexos_fila_idx ON email_ia.respostas_anexos (fila_id);
CREATE INDEX IF NOT EXISTS respostas_anexos_soltos_idx ON email_ia.respostas_anexos (caso_id, criado_em) WHERE fila_id IS NULL;
COMMENT ON TABLE email_ia.respostas_anexos IS 'Arquivos anexados pelo agente às respostas ao cliente (097). fila_id NULL = ainda não enviado com nenhuma resposta.';
