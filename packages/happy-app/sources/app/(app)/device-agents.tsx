import * as React from 'react';
import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/auth/AuthContext';
import { MainView } from '@/components/MainView';
import { workText as t } from '@/integrations/tokenhub/workText';
export default function DeviceAgents() { const auth=useAuth(); if(!auth.isAuthenticated)return <Redirect href="/" />;return <><Stack.Screen options={{title:t('agents')}}/><MainView variant="phone"/></>; }
