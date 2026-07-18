const axios = require('axios');

/**
 * API Client for letsbook.maakhq.com booking platform
 * Handles provider creation and message template retrieval
 */
class BookingApiClient {
  constructor() {
    this.baseUrl = 'https://letsbook.maakhq.com/api';
    this.rateLimitDelay = 2000; // 2 seconds between requests
    this.maxRetries = 3;
  }

  /**
   * Create a provider and get message templates
   * @param {string} businessName - Name of the business
   * @returns {Object} Provider data and message templates
   */
  async getProviderTemplates(businessName) {
    const requestData = { name: businessName };

    try {
      const response = await axios.post(
        `${this.baseUrl}/providers`,
        requestData,
        {
          headers: {
            'accept': 'application/json',
            'accept-language': 'en-US,en;q=0.9',
            'content-type': 'application/json',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
            'origin': 'https://letsbook.maakhq.com',
            'referer': 'https://letsbook.maakhq.com/create-provider/secret',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
          },
          timeout: 15000,
          validateStatus: (status) => status < 500
        }
      );

      // Handle rate limiting
      if (response.status === 429) {
        throw { type: 'rate_limit', retryable: true, delay: 60000 };
      }

      // Handle other non-success responses (200 or 201 are both success)
      if (response.status !== 200 && response.status !== 201) {
        throw {
          type: 'api_error',
          retryable: false,
          message: `HTTP ${response.status}`,
          details: response.data
        };
      }

      return this.parseResponse(response.data);

    } catch (error) {
      // If error is already classified (thrown above), rethrow it
      if (error.type) {
        throw error;
      }

      // Classify network/axios errors
      throw this.classifyError(error);
    }
  }

  /**
   * Parse and validate API response
   * @param {Object} data - Raw API response
   * @returns {Object} Parsed provider and templates
   */
  parseResponse(data) {
    // Expected response structure:
    // {
    //   provider: { id, name, email, slug, external_url },
    //   messages: [
    //     { label: "template1", message: "..." },
    //     { label: "template2", message: "..." },
    //     { label: "template3", message: "..." }
    //   ],
    //   message: "..."  (selected message - we'll ignore this and randomly select)
    // }

    if (!data || !data.provider) {
      throw {
        type: 'invalid_response',
        retryable: false,
        message: 'Missing provider in API response'
      };
    }

    if (!data.messages || !Array.isArray(data.messages) || data.messages.length < 3) {
      throw {
        type: 'invalid_response',
        retryable: false,
        message: `Expected 3 message templates, got ${data.messages?.length || 0}`
      };
    }

    return {
      provider: {
        id: data.provider.id,
        name: data.provider.name,
        email: data.provider.email,
        slug: data.provider.slug,
        external_url: data.provider.external_url
      },
      templates: data.messages.map(msg => ({
        label: msg.label,
        message: msg.message
      }))
    };
  }

  /**
   * Classify error for retry logic
   * @param {Error} error - Error object
   * @returns {Object} Classified error
   */
  classifyError(error) {
    const msg = error.message || '';

    // Network errors (connection refused, timeout, etc.)
    if (error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNRESET') {
      return {
        type: 'network_error',
        retryable: true,
        delay: 5000,
        message: `Network error: ${error.code}`
      };
    }

    // Request timeout
    if (msg.includes('timeout')) {
      return {
        type: 'timeout',
        retryable: true,
        delay: 5000,
        message: 'Request timeout'
      };
    }

    // Unknown error
    return {
      type: 'unknown_error',
      retryable: false,
      message: msg || 'Unknown error occurred'
    };
  }

  /**
   * Retry a function with exponential backoff
   * @param {Function} fn - Function to retry
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Promise} Result of function
   */
  async retryWithBackoff(fn, maxRetries = this.maxRetries) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Don't retry if not retryable
        if (!error.retryable) {
          throw error;
        }

        // Don't retry if this was the last attempt
        if (attempt === maxRetries) {
          throw error;
        }

        // Calculate delay (exponential backoff)
        const delay = error.delay || (1000 * Math.pow(2, attempt));
        console.log(`   -> Retry ${attempt}/${maxRetries} after ${delay}ms: ${error.message}`);

        await this.delay(delay);
      }
    }

    throw lastError;
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise}
   */
  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BookingApiClient };
