/**
 * POST /api/admin/login
 * Verify admin password
 */

import { verifyPassword } from '../../lib/auth.js';

export default async function handler(request, response) {
  // Set CORS headers
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }
  
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    const { password } = request.body;
    
    if (!password) {
      return response.status(400).json({
        success: false,
        error: 'Password is required'
      });
    }
    
    if (verifyPassword(password)) {
      return response.status(200).json({
        success: true,
        message: 'Login successful'
      });
    } else {
      return response.status(401).json({
        success: false,
        error: 'Invalid password'
      });
    }
    
  } catch (error) {
    console.error('Login error:', error);
    return response.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
}
