        mcpSession: McpSession,
        agent: Agent,
        forcedTool: (suspend (assistantMessage: String?, sessionContext: SessionContext) -> ToolCallResult)? = null,
        text: String
    ) {
        val rec = withContext(Dispatchers.IO) { recordingRepo.getRecording(recordingId) }
        val firestoreId = rec?.firestoreId
        val createdAt = rec?.localTimestamp ?: Clock.System.now()
        val sessionContext = sessionContextFor(recordingId, firestoreId, createdAt, text)

        trace.markEvent("agent_processing_start",
            TraceEventData.AgentProcessingStart(
                recordingId = recordingId,
                recordingEntryId = recordingEntryId,
                forcedToolPresent = forcedTool != null,
                agent = agent.label,
            )
        )
        val convEndIdx = agent.conversation.first().size
        persistUserMessageIfAbsent(recordingId, recordingEntryId, text, convEndIdx)
        val scope = CoroutineScope(currentCoroutineContext())
        val convUpdJob = watchConversationUpdates(scope, agent, recordingId, recordingEntryId)
        val iterationJob = watchAgentIterations(scope, agent, recordingId)
        try {
            agent.send(text, mcpSession, sessionContext)
        } catch (e: AgentNetworkException) {
            // Reset conversation to before processing so task retry works correctly
            logger.e(e) { "Error during agent processing" }
            convUpdJob.cancel()
            trace.markEvent("agent_processing_failed",
                TraceEventData.AgentProcessingFailed(
                    recordingId = recordingId,
                    recordingEntryId = recordingEntryId,
                    agent = agent.label,
                    reason = "Network error: ${e.message}"
                )
            )
            throw RecoverableTaskException("Network error during agent processing: ${e.message}", e)
        } catch (e: Throwable) {
            logger.e(e) { "Error during agent processing" }
        } finally {
            iterationJob.cancelAndJoin()
            convUpdJob.cancelAndJoin()
            updateConversation(recordingId, agent.conversation.first().take(convEndIdx))
        }
        val conv = agent.conversation.firstOrNull() ?: emptyList()
        // No tool messages
        val noToolRan = conv.drop(convEndIdx).none {
            it.role == MessageRole.tool
        }
        // Last tool message indicates fallback was requested
        val toolRequestedFallback = conv.drop(convEndIdx).lastOrNull { it.role == MessageRole.tool }?.let {
            it.semantic_result is SemanticResult.GenericFailure && (it.semantic_result as SemanticResult.GenericFailure).forceFallbackTool
        } ?: false
        val lastAssistantMessage = conv.drop(convEndIdx).lastOrNull { it.role == MessageRole.assistant }
        // A tagged answer is the agent's action, so no fallback is needed
        val answered = lastAssistantMessage?.isAnswer == true
        val forceTool = !answered && (noToolRan || toolRequestedFallback)
        if (forcedTool != null && forceTool) {
            // Agent did not take any action, force tool
            val forcedCallId = Uuid.random().toString()
            val toolResult = forcedTool(lastAssistantMessage?.content, sessionContext.copy(toolCallId = forcedCallId))
            logger.w { "Forcing tool call result into conversation" }
            agent.addMessage(
                ConversationMessageDocument(
                    role = MessageRole.tool,
                    content = toolResult.resultString,
                    semantic_result = toolResult.semanticResult,
                    tool_call_id = forcedCallId,
                    language_model_used = null,
                    is_forced_tool = true
                )
            )
        }
        updateConversation(recordingId, agent.conversation.first())
        finishTurn(recordingId, firestoreId, createdAt, agent.conversation.first().drop(convEndIdx))
        linkUserMessageToEntry(recordingId, recordingEntryId)
        trace.markEvent("agent_processing_end",
            TraceEventData.AgentProcessingEnd(
                recordingId = recordingId,
                recordingEntryId = recordingEntryId,
                forcedToolUsed = forcedTool != null && forceTool,
                agent = agent.label,
            )
        )
    }

    /**
     * Runs the tool call the user answered ([approved], else the denial is the result), as a
     * second result for [toolCallId], then lets the agent carry on from there.
     */
