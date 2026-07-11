require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
// 1️⃣ REPLACED NODEMAILER WITH RESEND
const { Resend } = require('resend');

const app = express();
app.use(cors()); 
app.use(express.json({ limit: '10mb' })); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// 2️⃣ INITIALIZE RESEND (Uses port 443, which bypasses Render's firewall)
const resend = new Resend(process.env.RESEND_API_KEY);

// 2. GENERATE & EMAIL CODE (SECURE - NO CONSOLE LOGS)
app.post('/api/auth/send-2fa', async (req, res) => {
  try {
    const { userId, email } = req.body;
    if (!email) return res.status(400).json({ error: "No registered email provided." });

    // Generate a secure 6-digit numeric code
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // Save code to Supabase profile
    const { error: dbError } = await supabase
      .from('profiles')
      .update({ two_factor_code: code })
      .eq('id', userId);

    if (dbError) throw dbError;

    // 3️⃣ DISPATCH VIA RESEND HTTP API
    // Note: Resend requires 'onboarding@resend.dev' for unverified free domains. 
    // Once you add your own domain, update this email address.
    const { data, error: mailError } = await resend.emails.send({
      from: 'Secure Banking <onboarding@resend.dev>',
      to: email, 
      subject: "Your 6-Digit Security Verification Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #004879; margin-bottom: 10px;">Authentication Required</h2>
          <p style="color: #333; font-size: 14px;">You are attempting to sign in from an unrecognized device. Please use the following security code to complete your login:</p>
          <div style="background-color: #f4f7f9; padding: 15px; text-align: center; margin: 20px 0; border-radius: 4px;">
            <span style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #0071ce; font-family: monospace;">${code}</span>
          </div>
          <p style="color: #666; font-size: 12px; margin-top: 20px;">If you did not attempt to sign in, please contact support immediately to freeze your account.</p>
        </div>
      `
    });

    if (mailError) throw mailError;

    res.json({ success: true, message: "Security code dispatched to registered email." });
  } catch (err) {
    console.error("2FA Dispatch Error:", err);
    res.status(500).json({ error: "Failed to dispatch verification email." });
  }
});

// 3. VERIFY CODE
app.post('/api/auth/verify-2fa', async (req, res) => {
  try {
    const { userId, code } = req.body;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('two_factor_code')
      .eq('id', userId)
      .single();

    if (error || !profile) return res.status(400).json({ error: "User profile not found." });

    if (profile.two_factor_code !== code.trim()) {
      return res.status(400).json({ error: "Invalid verification code. Please try again." });
    }

    // Clear the code after successful verification so it cannot be reused
    await supabase
      .from('profiles')
      .update({ two_factor_code: null })
      .eq('id', userId);

    res.json({ success: true });
  } catch (err) {
    console.error("2FA Verify Error:", err);
    res.status(500).json({ error: "Internal server error during verification." });
  }
});

const resolveUserId = async (identifier) => {
  if (identifier.includes('@')) {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) throw new Error("Failed to search users.");
    const user = users.find(u => u.email === identifier.toLowerCase().trim());
    if (!user) throw new Error("User with this email not found.");
    return user.id;
  }
  return identifier; 
};

app.get('/', (req, res) => res.send('🏦 Secure Bank API Running.'));

// --- MANAGER ROUTES ---

app.post('/api/manager/create-user', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: email.trim(),
      password: password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName, phone: phone }
    });
    if (authError) throw authError;

    const newUserId = authData.user.id;
    const legalName = `${firstName} ${lastName}`.trim(); 

    await supabase.from('profiles').insert([{ 
      id: newUserId, 
      account_status: 'active',
      legal_name: legalName,
      phone: phone 
    }]);
    
    await supabase.from('accounts').insert([{ user_id: newUserId, balance: 0.00, savings_balance: 0.00 }]);

    res.json({ message: `Success! Account created for ${email}.` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/manager/toggle-status', async (req, res) => {
  try {
    const { identifier, newStatus, managerId } = req.body; 
    const userId = await resolveUserId(identifier);
    
    const { error } = await supabase.from('profiles').update({ account_status: newStatus }).eq('id', userId);
    if (error) throw error;

    // Log to Audit Trail
    if (managerId) {
        await supabase.from('manager_audit_logs').insert([{
            manager_id: managerId,
            action_taken: 'TOGGLE_STATUS',
            target_user_id: userId,
            details: { updated_status: newStatus }
        }]);
    }

    res.json({ message: `Account updated to ${newStatus}` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/manager/inject-funds', async (req, res) => {
  try {
    const { identifier, amount, description, managerId } = req.body;
    const userId = await resolveUserId(identifier);
    
    const numAmount = parseFloat(amount);
    const isWithdrawal = numAmount < 0;
    const type = isWithdrawal ? 'withdrawal' : 'deposit';
    const absAmount = Math.abs(numAmount); 
    const finalDesc = description ? description : (isWithdrawal ? 'Manual Withdrawal' : 'Manual Deposit');

    const { data: account, error: fetchError } = await supabase.from('accounts').select('account_id, balance').eq('user_id', userId).single();
    if (fetchError) throw fetchError;

    const newBalance = parseFloat(account.balance) + numAmount;
    await supabase.from('accounts').update({ balance: newBalance }).eq('user_id', userId);
    
    // Using single-entry for manual injections
    const txData = {
        type: type, 
        amount: absAmount, 
        status: 'approved', 
        description: finalDesc,
        reference_id: `INJ-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    };
    if (isWithdrawal) txData.sender_account_id = account.account_id;
    else txData.receiver_account_id = account.account_id;

    await supabase.from('transactions').insert([txData]);

    // Log to Audit Trail
    if (managerId) {
        await supabase.from('manager_audit_logs').insert([{
            manager_id: managerId,
            action_taken: 'INJECT_FUNDS',
            target_user_id: userId,
            details: { amount: numAmount, old_balance: account.balance, new_balance: newBalance, description: finalDesc }
        }]);
    }

    res.json({ message: `Success! ${isWithdrawal ? 'Withdrew' : 'Deposited'} $${absAmount}.` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- UPDATE REWARDS ROUTE (MANAGER) ---
app.post('/api/manager/update-rewards', async (req, res) => {
  try {
    const { identifier, amount, action } = req.body; 
    const userId = await resolveUserId(identifier);

    const { data: account, error: fetchError } = await supabase
      .from('accounts')
      .select('rewards_balance')
      .eq('user_id', userId)
      .single();

    if (fetchError) throw fetchError;

    let currentRewards = parseFloat(account.rewards_balance || 0);
    let numAmount = parseFloat(amount);

    if (action === 'subtract') {
      if (currentRewards < numAmount) {
        return res.status(400).json({ error: "User does not have enough miles." });
      }
      currentRewards -= numAmount;
    } else {
      currentRewards += numAmount;
    }

    const { error: updateError } = await supabase
      .from('accounts')
      .update({ rewards_balance: currentRewards })
      .eq('user_id', userId);

    if (updateError) throw updateError;

    res.json({ message: `Success! Rewards updated. New balance: ${currentRewards.toLocaleString()} Miles.` });
  } catch (err) { 
    res.status(400).json({ error: err.message }); 
  }
});

// --- CREATE CREDIT CARD (MANAGER) ---
app.post('/api/manager/create-credit', async (req, res) => {
  try {
    const { identifier, cardName, creditLimit, balance, managerId } = req.body;
    const userId = await resolveUserId(identifier);
    
    // Generate a mock 16 digit card number starting with 4 (Visa)
    const mockCardNumber = '4' + Math.floor(Math.random() * 1000000000000000).toString().padStart(15, '0');

    const { error } = await supabase.from('credit_accounts').insert([{
      user_id: userId,
      card_name: cardName,
      card_number: mockCardNumber,
      credit_limit: parseFloat(creditLimit),
      balance: parseFloat(balance)
    }]);

    if (error) throw error;

    if (managerId) {
      await supabase.from('manager_audit_logs').insert([{
        manager_id: managerId, action_taken: 'ISSUE_CREDIT_CARD', target_user_id: userId,
        details: { card: cardName, limit: creditLimit, start_balance: balance }
      }]);
    }

    res.json({ message: `Success! Issued ${cardName} to user.` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- CREATE AUTO/PERSONAL LOAN (MANAGER) ---
app.post('/api/manager/create-loan', async (req, res) => {
  try {
    const { identifier, loanName, principal, monthlyPayment, nextPaymentDate, managerId } = req.body;
    const userId = await resolveUserId(identifier);
    
    const mockAccountNumber = Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');

    const { error } = await supabase.from('loan_accounts').insert([{
      user_id: userId,
      loan_name: loanName,
      account_number: mockAccountNumber,
      original_principal: parseFloat(principal),
      current_balance: parseFloat(principal), 
      monthly_payment: parseFloat(monthlyPayment),
      next_payment_date: nextPaymentDate
    }]);

    if (error) throw error;

    if (managerId) {
      await supabase.from('manager_audit_logs').insert([{
        manager_id: managerId, action_taken: 'ORIGINATE_LOAN', target_user_id: userId,
        details: { loan: loanName, principal: principal }
      }]);
    }

    res.json({ message: `Success! Originated ${loanName} for user.` });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// --- CLIENT ROUTES ---

app.post('/api/client/transfer', async (req, res) => {
  try {
    const { userId, amount, direction } = req.body; 
    const numAmount = parseFloat(amount);

    if (numAmount <= 0) {
      return res.status(400).json({ error: "Amount must be greater than zero." });
    }

    const { data: acc, error: fetchError } = await supabase
      .from('accounts')
      .select('balance, savings_balance, account_id')
      .eq('user_id', userId)
      .single();
      
    if (fetchError) throw fetchError;

    let newChecking = parseFloat(acc.balance);
    let newSavings = parseFloat(acc.savings_balance || 0);
    let transferDesc = '';

    if (direction === 'c2s') {
       if (newChecking < numAmount) {
         return res.status(400).json({ error: "Insufficient funds in 360 Checking." });
       }
       newChecking -= numAmount; 
       newSavings += numAmount; 
       transferDesc = "Transfer to Savings";
    } else {
       if (newSavings < numAmount) {
         return res.status(400).json({ error: "Insufficient funds in 360 Savings." });
       }
       newChecking += numAmount; 
       newSavings -= numAmount; 
       transferDesc = "Transfer to Checking";
    }

    const { error: updateError } = await supabase
      .from('accounts')
      .update({ balance: newChecking, savings_balance: newSavings })
      .eq('user_id', userId);
      
    if (updateError) throw updateError;

    await supabase.from('transactions').insert([{ 
      user_id: userId, 
      type: 'transfer', 
      amount: numAmount, 
      status: 'approved', 
      description: transferDesc,
      sender_account_id: acc.account_id,
      receiver_account_id: acc.account_id
    }]);

    res.json({ success: true });
  } catch (err) { 
    res.status(400).json({ error: err.message }); 
  }
});

// --- EXTERNAL TRANSFER LOGIC (WIRE & ZELLE) ---
const handleExternalTransfer = async (req, res, transferType) => {
  try {
    const { senderUserId, receiverAccountId, amount, description } = req.body;
    const numAmount = parseFloat(amount);

    if (!senderUserId || !receiverAccountId || isNaN(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: "Invalid transfer parameters." });
    }

    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .select('account_id, balance')
      .eq('user_id', senderUserId)
      .single();

    if (accErr || !account) return res.status(404).json({ error: "Account not found." });

    if (parseFloat(account.balance) < numAmount) {
      return res.status(400).json({ error: "Insufficient Funds." });
    }

    const newBalance = parseFloat(account.balance) - numAmount;
    const { error: updateErr } = await supabase
      .from('accounts')
      .update({ balance: newBalance })
      .eq('account_id', account.account_id);

    if (updateErr) throw updateErr;

    const referenceId = `${transferType.toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    await supabase.from('transactions').insert([{
      sender_account_id: account.account_id,
      receiver_account_id: receiverAccountId, 
      type: transferType, 
      amount: numAmount,
      status: 'approved',
      description: description || `${transferType.charAt(0).toUpperCase() + transferType.slice(1)} Transfer`,
      category: 'Transfer',
      reference_id: referenceId
    }]);

    res.json({ success: true, message: `${transferType} completed successfully.` });
  } catch (err) {
    console.error(`External Transfer Error (${transferType}):`, err);
    res.status(500).json({ error: "Internal server error during transfer." });
  }
};
app.post('/api/client/wire', (req, res) => handleExternalTransfer(req, res, 'wire'));
app.post('/api/client/zelle', (req, res) => handleExternalTransfer(req, res, 'zelle'));

// --- NEW DEBT PAYMENT ROUTE ---
app.post('/api/client/pay-debt', async (req, res) => {
    const { userId, sourceAccountId, debtId, debtType, amount } = req.body;
    const numAmount = parseFloat(amount);

    if (!userId || !sourceAccountId || !debtId || !debtType || isNaN(numAmount) || numAmount <= 0) {
        return res.status(400).json({ error: "Invalid request parameters." });
    }

    try {
        const { data: account, error: accErr } = await supabase
            .from('accounts')
            .select('balance')
            .eq('account_id', sourceAccountId)
            .single();

        if (accErr || !account) return res.status(404).json({ error: "Checking account not found." });

        if (parseFloat(account.balance) < numAmount) {
            return res.status(400).json({ error: "Insufficient Funds." });
        }

        const newCheckingBalance = parseFloat(account.balance) - numAmount;
        const { error: updateAccErr } = await supabase
            .from('accounts')
            .update({ balance: newCheckingBalance })
            .eq('account_id', sourceAccountId);

        if (updateAccErr) throw updateAccErr;

        let debtDescription = 'Debt Payment';

        if (debtType === 'credit') {
            const { data: creditAcc, error: credFetchErr } = await supabase
                .from('credit_accounts')
                .select('balance, card_name')
                .eq('id', debtId)
                .single();
                
            if (credFetchErr) throw credFetchErr;
            debtDescription = `Payment to ${creditAcc.card_name}`;

            const { error: credUpdateErr } = await supabase
                .from('credit_accounts')
                .update({ balance: parseFloat(creditAcc.balance) - numAmount })
                .eq('id', debtId);

            if (credUpdateErr) throw credUpdateErr;

        } else if (debtType === 'loan') {
            const { data: loanAcc, error: loanFetchErr } = await supabase
                .from('loan_accounts')
                .select('current_balance, loan_name')
                .eq('id', debtId)
                .single();

            if (loanFetchErr) throw loanFetchErr;
            debtDescription = `Payment to ${loanAcc.loan_name}`;

            const { error: loanUpdateErr } = await supabase
                .from('loan_accounts')
                .update({ current_balance: parseFloat(loanAcc.current_balance) - numAmount })
                .eq('id', debtId);

            if (loanUpdateErr) throw loanUpdateErr;
        } else {
            return res.status(400).json({ error: "Invalid debt type specified." });
        }

        const referenceId = `DP-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        const { error: txErr } = await supabase
            .from('transactions')
            .insert([{
                sender_account_id: sourceAccountId,
                type: 'withdrawal',
                amount: numAmount,
                status: 'approved',
                description: debtDescription,
                reference_id: referenceId,
                category: 'Transfer'
            }]);

        if (txErr) throw txErr;

        return res.status(200).json({ message: "Payment processed successfully.", newBalance: newCheckingBalance });

    } catch (error) {
        console.error("Debt Payment Error:", error);
        return res.status(500).json({ error: "Internal Server Error while processing payment." });
    }
});

const PORT = process.env.PORT || 3001;

// --- UPDATE CLIENT PROFILE PHOTO ---
app.post('/api/client/update-photo', async (req, res) => {
  try {
    const { userId, profilePhoto } = req.body;
    if (!userId) return res.status(400).json({ error: "User ID is required." });

    const { error } = await supabase
      .from('profiles')
      .update({ profile_photo: profilePhoto })
      .eq('id', userId);

    if (error) throw error;

    res.json({ success: true, message: "Profile photo synced across all devices." });
  } catch (err) {
    console.error("Photo Update Error:", err);
    res.status(500).json({ error: "Failed to save profile photo to server." });
  }
});

app.listen(PORT, () => console.log(`🏦 Secure Server alive on port ${PORT}`));