import { Contact, Member } from '@prisma/client';
import { log } from './logger.js';
import { prisma } from './prisma.js';

// Tipo temporário até executar a migração
type AssignmentRule = {
  id: string;
  organizationId: string;
  name: string;
  active: boolean;
  priority: number;
  conditionType: string;
  conditionValue: any;
  assignTo: string;
  assigneeIds: any;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Verifica se a organização tem auto-assignment ativado
 */
export async function shouldAutoAssign(organizationId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { autoAssignmentEnabled: true }
  });

  return org?.autoAssignmentEnabled ?? false;
}

/**
 * Avalia se uma regra de atribuição se aplica a um contato
 */
function evaluateRuleCondition(rule: AssignmentRule, contact: Contact): boolean {
  switch (rule.conditionType) {
    case 'always':
      return true;

    case 'channel':
      if (!contact.channelId) return false;
      const channelCondition = rule.conditionValue as { channelIds?: string[] };
      return channelCondition.channelIds?.includes(contact.channelId) ?? false;

    case 'tag':
      // Nota: Precisa carregar tags do contato se necessário
      // Por enquanto retorna false, pode ser implementado depois
      return false;

    case 'keyword':
      // Nota: Precisa analisar mensagens recentes do contato
      // Por enquanto retorna false, pode ser implementado depois
      return false;

    case 'time':
      // Nota: Pode verificar horário atual vs horário de trabalho
      // Por enquanto retorna false, pode ser implementado depois
      return false;

    default:
      return false;
  }
}

/**
 * Busca regras de atribuição aplicáveis ao contato
 */
async function getApplicableRules(
  organizationId: string,
  contact: Contact
): Promise<AssignmentRule[]> {
  const rules = await (prisma as any).assignmentRule.findMany({
    where: {
      organizationId,
      active: true
    },
    orderBy: {
      priority: 'desc'
    }
  }) as AssignmentRule[];

  return rules.filter(rule => evaluateRuleCondition(rule, contact));
}

/**
 * Busca agentes disponíveis para atribuição
 */
async function getAvailableAgents(
  organizationId: string,
  agentIds?: string[]
): Promise<Member[]> {
  const where: any = {
    organizationId,
    role: 'agent' // Apenas membros com role 'agent'
  };

  // Se foram especificados IDs de agentes, filtra por eles
  if (agentIds && agentIds.length > 0) {
    where.userId = { in: agentIds };
  }

  return prisma.member.findMany({
    where,
    include: {
      user: {
        include: {
          _count: {
            select: {
              assignedContacts: {
                where: {
                  convStatus: { in: ['open', 'pending'] } // Apenas conversas ativas
                }
              }
            }
          }
        }
      }
    }
  });
}

/**
 * Calcula a carga (número de conversas ativas) de um agente
 */
function getAgentLoad(member: any): number {
  return member.user._count.assignedContacts;
}

/**
 * Estratégia Round-Robin: seleciona o agente com menos conversas atribuídas
 */
function selectAgentRoundRobin(agents: any[]): string | null {
  if (agents.length === 0) return null;

  // Ordena agentes por número de conversas atribuídas (menor primeiro)
  const sorted = agents.sort((a, b) => getAgentLoad(a) - getAgentLoad(b));

  return sorted[0].userId;
}

/**
 * Estratégia Load-Balancing: igual ao round-robin, considera carga atual
 */
function selectAgentLoadBalancing(agents: any[]): string | null {
  return selectAgentRoundRobin(agents); // Mesma implementação
}

/**
 * Estratégia Random: seleciona um agente aleatório
 */
function selectAgentRandom(agents: any[]): string | null {
  if (agents.length === 0) return null;

  const randomIndex = Math.floor(Math.random() * agents.length);
  return agents[randomIndex].userId;
}

/**
 * Determina qual agente deve receber a atribuição
 */
export async function determineAssignee(
  organizationId: string,
  contact: Contact
): Promise<string | null> {
  try {
    // 1. Busca configurações da organização
    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        autoAssignmentEnabled: true,
        autoAssignmentStrategy: true
      }
    });

    if (!org?.autoAssignmentEnabled) {
      return null;
    }

    // 2. Busca regras aplicáveis
    const rules = await getApplicableRules(organizationId, contact);

    // 3. Determina pool de agentes baseado nas regras
    let agentIds: string[] | undefined;

    if (rules.length > 0) {
      // Usa a regra de maior prioridade
      const rule = rules[0];

      if (rule.assignTo === 'specific') {
        // Atribui a agentes específicos da regra
        agentIds = rule.assigneeIds as string[];
      }
      // Para 'round-robin' e 'load-balancing', usa todos os agentes disponíveis
    }

    // 4. Busca agentes disponíveis
    const agents = await getAvailableAgents(organizationId, agentIds);

    if (agents.length === 0) {
      log.warn(`No available agents for organization ${organizationId}`);
      return null;
    }

    // 5. Seleciona agente baseado na estratégia
    const strategy = org.autoAssignmentStrategy || 'round-robin';

    switch (strategy) {
      case 'round-robin':
        return selectAgentRoundRobin(agents);

      case 'load-balancing':
        return selectAgentLoadBalancing(agents);

      case 'random':
        return selectAgentRandom(agents);

      default:
        return selectAgentRoundRobin(agents);
    }

  } catch (error) {
    log.error('Error determining assignee:', error);
    return null;
  }
}

/**
 * Atribui um contato a um agente e notifica via SSE
 */
export async function assignContact(
  contactId: string,
  assigneeId: string,
  organizationId: string
): Promise<boolean> {
  try {
    // Atualiza o contato
    const contact = await prisma.contact.update({
      where: { id: contactId },
      data: { assignedToId: assigneeId },
      include: {
        assignedTo: {
          select: { name: true }
        }
      }
    });

    log.info(`Contact ${contactId} assigned to agent ${assigneeId}`);

    // TODO: Publicar evento SSE conv_updated
    // publishToOrg(organizationId, {
    //   type: 'conv_updated',
    //   contactId,
    //   convStatus: contact.convStatus,
    //   assignedToId: assigneeId,
    //   assignedToName: contact.assignedTo?.name ?? null
    // });

    return true;

  } catch (error) {
    log.error('Error assigning contact:', error);
    return false;
  }
}

/**
 * Processa auto-assignment para um novo contato/mensagem
 */
export async function processAutoAssignment(
  contactId: string,
  organizationId: string
): Promise<void> {
  try {
    // Verifica se auto-assignment está ativado
    if (!await shouldAutoAssign(organizationId)) {
      return;
    }

    // Busca o contato
    const contact = await prisma.contact.findUnique({
      where: { id: contactId }
    });

    if (!contact) {
      log.warn(`Contact ${contactId} not found`);
      return;
    }

    // Se já está atribuído, não faz nada
    if (contact.assignedToId) {
      return;
    }

    // Determina o agente
    const assigneeId = await determineAssignee(organizationId, contact);

    if (!assigneeId) {
      log.warn(`No assignee determined for contact ${contactId}`);
      return;
    }

    // Atribui o contato
    await assignContact(contactId, assigneeId, organizationId);

  } catch (error) {
    log.error('Error processing auto-assignment:', error);
  }
}
