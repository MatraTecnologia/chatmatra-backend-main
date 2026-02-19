# 🔍 Guia de Debug Multi-Tenant

## Problema Atual

Quando você acessa `https://chatmatra.matratecnologia.com` e a aplicação faz requests para `https://api.chatmatra.matratecnologia.com/organizations/current`, está retornando erro 400:

```json
{"error": "Nenhuma organização detectada para este domínio."}
```

## O que foi feito

### 1. ✅ Logging adicionado em `session.ts`

Adicionei logs detalhados que mostram:
- 🔍 Qual é o header `Origin` recebido
- ✅ Hostname extraído do Origin
- 🎯 Hostname final após todas as prioridades
- 🔎 Domínio sendo buscado no banco
- 📊 Se a organização foi encontrada
- 👤 Se o usuário é membro

### 2. ✅ Scripts de verificação criados

Dois scripts foram criados para ajudar no debug:

#### **`npm run check-orgs`**
Mostra todas as organizações no banco de dados e seus domínios

#### **`npm run fix-org-domains`**
Permite atualizar os domínios das organizações

---

## 🚀 Passo a Passo para Resolver

### **Passo 1: Verifique os logs do backend**

Acesse os logs do backend (EasyPanel ou Docker logs) e procure por linhas com `[MULTI-TENANT]`:

```bash
# No EasyPanel/Docker
docker logs <container-name> --tail 100 -f
```

Você verá algo como:
```
[MULTI-TENANT] 🔍 Origin header: https://chatmatra.matratecnologia.com
[MULTI-TENANT] ✅ Hostname extraído do Origin: chatmatra.matratecnologia.com
[MULTI-TENANT] 🎯 Hostname final: chatmatra.matratecnologia.com
[MULTI-TENANT] 🔎 Buscando organização com domain: chatmatra.matratecnologia.com
[MULTI-TENANT] 📊 Organização encontrada: null
[MULTI-TENANT] ⚠️ Nenhuma organização encontrada para o domain: chatmatra.matratecnologia.com
```

### **Passo 2: Verifique as organizações no banco**

Execute o script de verificação:

```bash
cd chatmatra-backend-main
npm run check-orgs
```

Isso mostrará todas as organizações e seus domínios atuais. Exemplo de saída:

```
🔍 Verificando organizações no banco de dados...

✅ Total de organizações: 2

1. ChatMatra
   ID: clzxxx123...
   Domain: (null/vazio)
   Criado em: 2024-02-19...

2. Teste Org
   ID: clzyyy456...
   Domain: (null/vazio)
   Criado em: 2024-02-19...
```

### **Passo 3: Identifique o problema**

Compare os logs do Passo 1 com as organizações do Passo 2:

**❌ Problema comum**: O campo `domain` das organizações está `null` ou vazio

**✅ Solução**: Atualizar os domínios das organizações

### **Passo 4: Atualize os domínios**

Edite o arquivo `fix-org-domains.js` e adicione as atualizações:

```javascript
const updates = [
    { id: 'clzxxx123...', domain: 'chatmatra.matratecnologia.com' },
    { id: 'clzyyy456...', domain: 'teste.matratecnologia.com' },
]
```

**⚠️ IMPORTANTE**: Use os IDs reais que você viu no Passo 2!

Depois execute:

```bash
npm run fix-org-domains
```

### **Passo 5: Teste novamente**

1. Acesse `https://chatmatra.matratecnologia.com`
2. Verifique os logs do backend
3. Agora você deve ver:
   ```
   [MULTI-TENANT] 📊 Organização encontrada: { id: 'clzxxx123...' }
   [MULTI-TENANT] ✅ organizationId injetado no request: clzxxx123...
   ```

---

## 🔐 Estrutura Multi-Tenant

### Como funciona

1. **Frontend** (`chatmatra.matratecnologia.com`) faz request para **API** (`api.chatmatra.matratecnologia.com`)
2. API recebe o header `Origin: https://chatmatra.matratecnologia.com`
3. API extrai o hostname `chatmatra.matratecnologia.com` do Origin
4. API busca organização com `domain = 'chatmatra.matratecnologia.com'`
5. API verifica se o usuário logado é membro dessa organização
6. API injeta `request.organizationId` para uso nos endpoints

### Domínios esperados

No seu caso, você deve ter as seguintes organizações com estes domínios:

| Organização | Domain |
|-------------|--------|
| ChatMatra | `chatmatra.matratecnologia.com` |
| Teste | `teste.matratecnologia.com` |

**⚠️ NÃO use**: `api.chatmatra.matratecnologia.com` (este é o domínio da API, não do tenant)

---

## 🐛 Outros problemas possíveis

### 1. CORS Error

Se você ver erro de CORS:
```
Access to XMLHttpRequest at 'https://api.chatmatra.matratecnologia.com/...'
from origin 'https://chatmatra.matratecnologia.com' has been blocked by CORS policy
```

**Verificar**: O backend já está configurado com `origin: true` no `server.ts`, então isso NÃO deve ser um problema.

Se ainda ocorrer:
- Verifique se o COOKIE_DOMAIN está configurado: `COOKIE_DOMAIN=.matratecnologia.com`
- Verifique se o BASE_DOMAIN está configurado: `BASE_DOMAIN=matratecnologia.com`

### 2. Sessão não funciona entre subdomínios

Se o login funciona mas a sessão não é reconhecida:
- Verifique `COOKIE_DOMAIN=.matratecnologia.com` (com ponto no início!)
- Verifique `BASE_DOMAIN=matratecnologia.com` (sem ponto)

### 3. Organização encontrada mas usuário não é membro

Se você ver:
```
[MULTI-TENANT] 📊 Organização encontrada: { id: '...' }
[MULTI-TENANT] 👤 Membro encontrado: null
[MULTI-TENANT] 🚫 Usuário não é membro da organização
```

**Solução**: O usuário precisa ser adicionado como membro da organização. Verifique a tabela `Member` no banco de dados.

---

## 📝 Resumo do Fluxo

```
1. Usuário acessa https://chatmatra.matratecnologia.com
   ↓
2. Frontend faz request para https://api.chatmatra.matratecnologia.com/organizations/current
   ↓
3. Backend recebe Origin: https://chatmatra.matratecnologia.com
   ↓
4. Backend extrai hostname: chatmatra.matratecnologia.com
   ↓
5. Backend busca Organization onde domain = 'chatmatra.matratecnologia.com'
   ↓
6. Backend verifica se usuário é Member dessa Organization
   ↓
7. Backend injeta request.organizationId
   ↓
8. Endpoint /organizations/current usa request.organizationId
```

---

## 🆘 Se ainda não funcionar

1. ✅ Execute `npm run check-orgs` e me envie a saída
2. ✅ Me envie os logs do backend (linhas com `[MULTI-TENANT]`)
3. ✅ Me confirme quais são os domínios que você quer usar para cada organização
